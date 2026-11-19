"""Sign-in with the fake Pocket ID: the browser side of the authorization code flow."""

import base64
import json
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from blob.oidc import MAX_PENDING, safe_next
from tests.conftest import CLIENT_ID, PUBLIC_URL, signed_in, wait_ready
from tests.fakes.fake_pocketid import AUTHORIZE, ISSUER, FakePocketId


@pytest.fixture
def web(app_factory: Any) -> Iterator[TestClient]:
    with TestClient(app_factory(), follow_redirects=False) as c:
        wait_ready(c)
        yield c


def start(c: TestClient, next_path: str = "/") -> dict[str, str]:
    r = c.get("/auth/login", params={"next": next_path})
    assert r.status_code == 302
    assert r.headers["cache-control"] == "no-store"
    url = urlsplit(r.headers["location"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == AUTHORIZE
    return {k: v[0] for k, v in parse_qs(url.query).items()}


def sign_in(c: TestClient, pocket_id: FakePocketId, next_path: str = "/", **claims: Any) -> Any:
    q = start(c, next_path)
    pocket_id.issue("code-1", q["code_challenge"], q["nonce"], **claims)
    return c.get("/auth/callback", params={"code": "code-1", "state": q["state"]})


def test_login_redirects_to_the_provider(web: TestClient) -> None:
    q = start(web)
    assert q["response_type"] == "code"
    assert q["client_id"] == CLIENT_ID
    assert q["redirect_uri"] == f"{PUBLIC_URL}/auth/callback"
    assert set(q["scope"].split()) == {"openid", "profile", "email", "groups"}
    assert q["code_challenge_method"] == "S256"
    assert len({q["state"], q["nonce"], q["code_challenge"]}) == 3
    assert web.cookies.get("blob_login") == q["state"]


def test_full_sign_in(web: TestClient, pocket_id: FakePocketId) -> None:
    r = sign_in(web, pocket_id, "/?enroll=1")
    assert r.status_code == 303
    assert r.headers["location"] == "/?enroll=1"
    cookie = r.headers.get_list("set-cookie")
    session = next(h for h in cookie if h.startswith("blob_session="))
    assert "HttpOnly" in session and "SameSite=lax" in session and "Max-Age=" in session
    assert "Secure" not in session  # PUBLIC_URL is http in the tests
    cfg = web.get("/device-config")  # the cookie jar now holds the session
    assert cfg.status_code == 200
    assert (cfg.json()["device"], cfg.json()["sound"], cfg.json()["wake"]) == ("tablet", True, True)
    [req] = pocket_id.token_requests
    assert req["grant_type"] == "authorization_code"
    assert req["redirect_uri"] == f"{PUBLIC_URL}/auth/callback"
    assert req["client_id"] == CLIENT_ID and req["authorization"] is None  # public client


def test_confidential_client_sends_basic_auth(app_factory: Any, pocket_id: FakePocketId) -> None:
    with TestClient(app_factory(oidc_client_secret="s3cr:t"), follow_redirects=False) as c:
        assert sign_in(c, pocket_id).status_code == 303
    auth = pocket_id.token_requests[0]["authorization"]
    assert base64.b64decode(auth.removeprefix("Basic ")).decode() == f"{CLIENT_ID}:s3cr%3At"


def test_secure_cookie_on_https(app_factory: Any, pocket_id: FakePocketId) -> None:
    with TestClient(app_factory(public_url="https://blob.test"), follow_redirects=False) as c:
        r = sign_in(c, pocket_id)
    assert all("Secure" in h for h in r.headers.get_list("set-cookie"))


def test_groups_decide_the_flags(web: TestClient, pocket_id: FakePocketId) -> None:
    sign_in(web, pocket_id, preferred_username=None, name="Arnau", groups=None)
    cfg = web.get("/device-config").json()
    assert (cfg["device"], cfg["sound"], cfg["wake"]) == ("Arnau", False, False)


def test_signing_in_again_replaces_the_session(web: TestClient, pocket_id: FakePocketId) -> None:
    sign_in(web, pocket_id, groups=[])
    old = web.cookies["blob_session"]
    sign_in(web, pocket_id, groups=["blob-wake"])
    assert web.cookies["blob_session"] != old
    assert web.get("/device-config").json()["wake"] is True
    web.cookies.clear()
    assert web.get("/device-config", headers={"Cookie": f"blob_session={old}"}).status_code == 401


@pytest.mark.parametrize(
    "target", ["https://evil.test/", "//evil.test", "/\\evil.test", "evil", "", None]
)
def test_next_stays_on_blob(target: str | None) -> None:
    assert safe_next(target) == "/"


def test_next_keeps_paths() -> None:
    assert safe_next("/?enroll=1") == "/?enroll=1"


def test_open_redirect_refused(web: TestClient, pocket_id: FakePocketId) -> None:
    assert sign_in(web, pocket_id, "//evil.test/x").headers["location"] == "/"


def test_callback_needs_the_login_cookie(web: TestClient, pocket_id: FakePocketId) -> None:
    q = start(web)
    pocket_id.issue("code-1", q["code_challenge"], q["nonce"])
    web.cookies.delete("blob_login")  # an attacker's callback link opened in the victim's browser
    r = web.get("/auth/callback", params={"code": "code-1", "state": q["state"]})
    assert r.status_code == 400
    assert web.get("/device-config").status_code == 401


def test_callback_replay_and_unknown_state(web: TestClient, pocket_id: FakePocketId) -> None:
    q = start(web)
    pocket_id.issue("code-1", q["code_challenge"], q["nonce"])
    params = {"code": "code-1", "state": q["state"]}
    web.cookies.set("blob_login", q["state"], path="/auth")
    assert web.get("/auth/callback", params=params).status_code == 303
    web.cookies.set("blob_login", q["state"], path="/auth")
    assert web.get("/auth/callback", params=params).status_code == 400
    assert web.get("/auth/callback", params={"code": "x"}).status_code == 400


def test_callback_error_from_the_provider(web: TestClient) -> None:
    r = web.get("/auth/callback", params={"error": "access_denied"})
    assert r.status_code == 403 and "access_denied" in r.text


@pytest.mark.parametrize(
    "claims",
    [
        {"nonce": "other"},
        {"aud": "another-client"},
        {"iss": "https://other.test"},
        {"exp": int(time.time()) - 3600},
        {"sub": None},
        {"aud": [CLIENT_ID, "another"], "azp": "another"},
    ],
)
def test_bad_id_tokens_are_refused(
    web: TestClient, pocket_id: FakePocketId, claims: dict[str, Any]
) -> None:
    assert sign_in(web, pocket_id, **claims).status_code == 502
    assert web.get("/device-config").status_code == 401


def test_wrong_pkce_verifier_is_refused(web: TestClient, pocket_id: FakePocketId) -> None:
    q = start(web)
    pocket_id.issue("code-1", "not-the-challenge", q["nonce"])
    r = web.get("/auth/callback", params={"code": "code-1", "state": q["state"]})
    assert r.status_code == 502


def _unsigned(claims: dict[str, Any]) -> str:
    def b64(d: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}."


async def test_unsigned_and_foreign_tokens_are_refused(app_factory: Any, pocket_id: Any) -> None:
    from cryptography.hazmat.primitives.asymmetric import rsa

    from blob.oidc import OidcClient, OidcError

    client = OidcClient(
        ISSUER, CLIENT_ID, "", "http://blob.test/cb", transport=pocket_id.transport()
    )
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "s", "iat": now, "exp": now + 60}
    with pytest.raises(OidcError):
        await client._verify(_unsigned(claims))
    real_key = pocket_id.key
    pocket_id.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = pocket_id.sign(claims)
    pocket_id.key = real_key
    with pytest.raises(OidcError):
        await client._verify(forged)
    await client.aclose()


async def test_rotated_key_is_fetched_again(pocket_id: FakePocketId) -> None:
    from blob.oidc import OidcClient

    client = OidcClient(
        ISSUER, CLIENT_ID, "", "http://blob.test/cb", transport=pocket_id.transport()
    )
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "s", "iat": now, "exp": now + 60}
    assert (await client._verify(pocket_id.sign(claims)))["sub"] == "s"
    pocket_id.kid = "k2"  # new key id published in the JWKS
    assert (await client._verify(pocket_id.sign(claims)))["sub"] == "s"
    await client.aclose()


def test_provider_down(web: TestClient, pocket_id: FakePocketId) -> None:
    pocket_id.down = True
    r = web.get("/auth/login")
    assert r.status_code == 502 and "unreachable" in r.text
    pocket_id.down = False
    assert web.get("/auth/login").status_code == 302  # discovery is retried on the next login


def test_pending_logins_are_capped(web: TestClient) -> None:
    for _ in range(MAX_PENDING + 20):
        web.get("/auth/login")
    assert len(web.app.state.oidc._pending) <= MAX_PENDING  # type: ignore[attr-defined]


def test_stored_session_still_works(web: TestClient) -> None:
    assert web.get("/device-config", headers=signed_in("tablet")).json()["wake"] is True
