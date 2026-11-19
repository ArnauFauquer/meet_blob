"""A fake Pocket ID: discovery, JWKS and a token endpoint that signs ID tokens with an RSA key."""

import base64
import hashlib
import json
import time
from typing import Any
from urllib.parse import parse_qs

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://id.test"
AUTHORIZE = f"{ISSUER}/authorize"
TOKEN = f"{ISSUER}/api/oidc/token"
JWKS = f"{ISSUER}/.well-known/jwks.json"


class FakePocketId:
    def __init__(self, client_id: str) -> None:
        self.client_id = client_id
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "k1"
        # code -> (claims, PKCE challenge); claims may override anything in the ID token
        self.codes: dict[str, tuple[dict[str, Any], str]] = {}
        self.token_requests: list[dict[str, Any]] = []
        self.down = False

    def issue(self, code: str, challenge: str, nonce: str, /, **claims: Any) -> None:
        """What the provider remembers when the user signs in and it redirects back with code."""
        now = int(time.time())
        base = {
            "iss": ISSUER,
            "aud": self.client_id,
            "sub": "user-1",
            "iat": now,
            "exp": now + 3600,
            "nonce": nonce,
            "preferred_username": "tablet",
            "groups": ["blob-sound", "blob-wake"],
        }
        base.update(claims)
        self.codes[code] = ({k: v for k, v in base.items() if v is not None}, challenge)

    def sign(self, claims: dict[str, Any], kid: str | None = None) -> str:
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": kid or self.kid})

    def _jwks(self) -> dict[str, Any]:
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        return {"keys": [{**jwk, "kid": self.kid, "use": "sig", "alg": "RS256"}]}

    def _handle(self, req: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("down", request=req)
        url = str(req.url).split("?")[0]
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": AUTHORIZE,
                    "token_endpoint": TOKEN,
                    "jwks_uri": JWKS,
                },
            )
        if url == JWKS:
            return httpx.Response(200, json=self._jwks())
        if url == TOKEN and req.method == "POST":
            form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
            self.token_requests.append({**form, "authorization": req.headers.get("authorization")})
            entry = self.codes.pop(form.get("code", ""), None)
            if entry is None:
                return httpx.Response(400, json={"error": "invalid_grant"})
            claims, challenge = entry
            digest = hashlib.sha256(form.get("code_verifier", "").encode()).digest()
            if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != challenge:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(
                200,
                json={"access_token": "at", "token_type": "Bearer", "id_token": self.sign(claims)},
            )
        return httpx.Response(404)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)
