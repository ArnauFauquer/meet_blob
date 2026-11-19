"""Browser sign-in with OpenID Connect (Pocket ID): authorization code flow with PKCE.

GET /auth/login sends the browser to the provider, GET /auth/callback checks the answer, verifies
the ID token against the provider's keys, stores a session (auth.Sessions) and sets its cookie.
POST /auth/logout deletes the session. Opening /auth/login again replaces the session, which is
how a browser picks up group changes made in Pocket ID.
"""

import base64
import hashlib
import logging
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

import httpx
import jwt
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, RedirectResponse, Response

from .auth import (
    SESSION_COOKIE,
    Sessions,
    User,
    clear_session_cookie,
    secure_cookies,
    set_session_cookie,
)

log = logging.getLogger(__name__)

SCOPES = "openid profile email groups"
LOGIN_COOKIE = "blob_login"  # binds the callback to the browser that started the login
LOGIN_TTL_S = 600
MAX_PENDING = 200  # unauthenticated callers can start logins; keep the table small
# Asymmetric algorithms only: never "none" or an HMAC keyed with a public value.
ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"]
LEEWAY_S = 60


class OidcError(Exception):
    """The provider could not be reached or its answer failed a check."""


@dataclass
class _Pending:
    nonce: str
    verifier: str
    next: str
    created: float


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def safe_next(target: str | None) -> str:
    """Only same-site paths: no scheme, no host, no protocol-relative //host."""
    if not target or not target.startswith("/") or target.startswith(("//", "/\\")):
        return "/"
    return target


class OidcClient:
    def __init__(
        self,
        issuer: str,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.issuer = issuer
        self.client_id = client_id
        self._secret = client_secret
        self.redirect_uri = redirect_uri
        self._http = httpx.AsyncClient(timeout=10, transport=transport)
        self._wall = wall
        self._meta: dict[str, Any] | None = None
        self._keys: jwt.PyJWKSet | None = None
        self._pending: OrderedDict[str, _Pending] = OrderedDict()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _get_json(self, url: str) -> dict[str, Any]:
        try:
            r = await self._http.get(url)
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise OidcError(f"GET {url} failed: {e!r}") from e
        if not isinstance(data, dict):
            raise OidcError(f"GET {url}: not a JSON object")
        return data

    async def metadata(self) -> dict[str, Any]:
        """Discovery, read on first use (the provider may start after Blob) and then kept."""
        if self._meta is None:
            meta = await self._get_json(f"{self.issuer}/.well-known/openid-configuration")
            if str(meta.get("issuer", "")).rstrip("/") != self.issuer:
                raise OidcError(f"discovery issuer {meta.get('issuer')!r} is not {self.issuer!r}")
            for field in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
                if not isinstance(meta.get(field), str):
                    raise OidcError(f"discovery has no {field}")
            self._meta = meta
        return self._meta

    async def start(self, next_path: str) -> tuple[str, str]:
        """A new login: returns the provider URL to redirect to and the state for the cookie."""
        meta = await self.metadata()
        now = self._wall()
        while self._pending:
            oldest = next(iter(self._pending.values()))
            if len(self._pending) < MAX_PENDING and now - oldest.created < LOGIN_TTL_S:
                break
            self._pending.popitem(last=False)
        state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
        self._pending[state] = _Pending(nonce, verifier, safe_next(next_path), now)
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": SCOPES,
                "state": state,
                "nonce": nonce,
                "code_challenge": _challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        return f"{meta['authorization_endpoint']}?{query}", state

    def take(self, state: str) -> _Pending | None:
        """The pending login for this state, once (a replayed callback finds nothing)."""
        p = self._pending.pop(state, None)
        if p is None or self._wall() - p.created > LOGIN_TTL_S:
            return None
        return p

    async def finish(self, code: str, pending: _Pending) -> User:
        meta = await self.metadata()
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "code_verifier": pending.verifier,
            "client_id": self.client_id,
        }
        headers = {}
        if self._secret:  # client_secret_basic; both parts are form-encoded first (RFC 6749 2.3.1)
            pair = f"{quote(self.client_id, safe='')}:{quote(self._secret, safe='')}"
            headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
        try:
            r = await self._http.post(meta["token_endpoint"], data=data, headers=headers)
        except httpx.HTTPError as e:
            raise OidcError(f"token request failed: {e!r}") from e
        if r.status_code != 200:
            raise OidcError(f"token endpoint answered {r.status_code}: {r.text[:200]}")
        try:
            id_token = r.json()["id_token"]
        except (ValueError, KeyError, TypeError) as e:
            raise OidcError("token response has no id_token") from e
        claims = await self._verify(str(id_token))
        if not secrets.compare_digest(str(claims.get("nonce", "")), pending.nonce):
            raise OidcError("ID token nonce does not match")
        groups = claims.get("groups") or []
        if not isinstance(groups, list):
            groups = []
        sub = str(claims["sub"])
        name = claims.get("preferred_username") or claims.get("name") or claims.get("email") or sub
        return User(sub=sub, name=str(name), groups=tuple(str(g) for g in groups))

    async def _key(self, kid: str | None, refresh: bool = False) -> jwt.PyJWK:
        if self._keys is None or refresh:
            meta = await self.metadata()
            try:
                self._keys = jwt.PyJWKSet.from_dict(await self._get_json(meta["jwks_uri"]))
            except jwt.PyJWTError as e:
                raise OidcError(f"unusable JWKS: {e}") from e
        keys = [k for k in self._keys.keys if kid is None or k.key_id == kid]
        if not keys:
            if not refresh:  # the provider may have rotated its keys
                return await self._key(kid, refresh=True)
            raise OidcError(f"no signing key {kid!r} in the provider's JWKS")
        return keys[0]

    async def _verify(self, id_token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(id_token)
            key = await self._key(header.get("kid"))
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key=key,
                algorithms=ALGORITHMS,
                audience=self.client_id,
                issuer=self.issuer,
                leeway=LEEWAY_S,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as e:
            raise OidcError(f"ID token rejected: {e}") from e
        aud = claims["aud"]
        if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != self.client_id:
            raise OidcError("ID token azp is not this client")
        return claims


router = APIRouter(prefix="/auth")


def _text(status: int, text: str) -> PlainTextResponse:
    return PlainTextResponse(text, status_code=status, headers={"Cache-Control": "no-store"})


@router.get("/login")
async def login(request: Request, next: str = "/") -> Response:
    if request.app.state.settings.auth_disabled:  # nothing to sign in to
        return RedirectResponse(safe_next(next), status_code=302)
    oidc: OidcClient = request.app.state.oidc
    try:
        url, state = await oidc.start(next)
    except OidcError as e:
        log.warning("sign-in unavailable: %s", e)
        return _text(502, "Sign-in provider unreachable. Try again in a moment.")
    resp = RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})
    resp.set_cookie(
        LOGIN_COOKIE,
        state,
        max_age=LOGIN_TTL_S,
        path="/auth",
        httponly=True,
        secure=secure_cookies(request.app.state.settings.public_url),
        samesite="lax",
    )
    return resp


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = "") -> Response:
    oidc: OidcClient = request.app.state.oidc
    if error:
        return _text(403, f"Sign-in refused by the provider ({error[:100]}).")
    cookie = request.cookies.get(LOGIN_COOKIE, "")
    pending = oidc.take(state) if state and secrets.compare_digest(cookie, state) else None
    if pending is None or not code:
        return _text(400, "Sign-in expired or started in another browser. Open Blob again.")
    try:
        user = await oidc.finish(code, pending)
    except OidcError as e:
        log.warning("sign-in failed: %s", e)
        return _text(502, "Sign-in failed. Open Blob again.")
    sessions: Sessions = request.app.state.sessions
    await sessions.delete(request.cookies.get(SESSION_COOKIE, ""))  # the session it replaces
    session_id = await sessions.create(user)
    log.info("signed in: %s groups=%s", user.name, ",".join(user.groups))
    public_url = request.app.state.settings.public_url
    resp = RedirectResponse(pending.next, status_code=303, headers={"Cache-Control": "no-store"})
    set_session_cookie(resp, session_id, public_url)
    resp.delete_cookie(LOGIN_COOKIE, path="/auth", secure=secure_cookies(public_url))
    return resp


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    sessions: Sessions = request.app.state.sessions
    await sessions.delete(request.cookies.get(SESSION_COOKIE, ""))
    resp = Response(status_code=204)
    clear_session_cookie(resp, request.app.state.settings.public_url)
    return resp
