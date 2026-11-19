from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blob.auth import TOUCH_EVERY_S, Sessions, User, _hash, token_ok
from blob.db import Db
from tests.conftest import signed_in


def test_token_ok() -> None:
    assert token_ok("abc", "abc")
    assert not token_ok("abd", "abc")
    assert not token_ok("", "abc")
    assert token_ok("ñ", "ñ")


@pytest.mark.parametrize(
    "headers", [{}, {"Cookie": "blob_session=nope"}, {"Authorization": "Bearer test-alert-token"}]
)
def test_device_config_needs_a_session(client: TestClient, headers: dict[str, str]) -> None:
    assert client.get("/device-config", headers=headers).status_code == 401


def test_device_config_with_a_session(client: TestClient) -> None:
    assert client.get("/device-config", headers=signed_in()).status_code == 200


async def test_sessions_expire_when_idle(tmp_path: Path) -> None:
    now = [1_000_000.0]
    db = Db(str(tmp_path / "b.db"))
    sessions = Sessions(db, idle_days=2, wall=lambda: now[0])
    user = User("sub", "tablet", ("blob-wake",))
    sid = await sessions.create(user)
    assert await sessions.get(sid) == user
    assert await sessions.get("") is None
    assert await sessions.get("other") is None
    assert db._get_session(sid) is None  # only the hash is stored

    now[0] += TOUCH_EVERY_S - 1  # recent use is not written again
    await sessions.get(sid)
    assert db._get_session(_hash(sid))["seen_at"] == 1_000_000  # type: ignore[index]
    now[0] += 2 * 86400 - TOUCH_EVERY_S  # used within the idle limit: renewed
    assert await sessions.get(sid) == user
    assert db._get_session(_hash(sid))["seen_at"] == int(now[0])  # type: ignore[index]
    now[0] += 2 * 86400 + 1  # idle too long: gone
    assert await sessions.get(sid) is None
    assert db._get_session(_hash(sid)) is None

    stale = await sessions.create(user)
    now[0] += 3 * 86400
    fresh = await sessions.create(user)
    assert await sessions.delete_idle() == 1
    assert db._get_session(_hash(stale)) is None
    assert await sessions.get(fresh) == user
    await sessions.delete(fresh)
    assert await sessions.get(fresh) is None
    db.close()


def test_logout(client: TestClient) -> None:
    r = client.post("/auth/logout", headers=signed_in())
    assert r.status_code == 204
    assert 'blob_session=""' in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]
    assert client.get("/device-config", headers=signed_in()).status_code == 401
    assert client.post("/auth/logout").status_code == 204  # signed out already: fine


def test_auth_disabled_needs_no_provider(tmp_path: Path) -> None:
    from tests.conftest import make_settings

    s = make_settings(
        tmp_path, auth_disabled=True, public_url="", oidc_issuer="", oidc_client_id=""
    )
    assert s.auth_disabled
    with pytest.raises(ValueError, match="OIDC_ISSUER"):
        make_settings(tmp_path, oidc_issuer="")


def test_auth_disabled_lets_everyone_in(app_factory: Any) -> None:
    from blob import __version__

    app = app_factory(auth_disabled=True, public_url="", oidc_issuer="", oidc_client_id="")
    with TestClient(app, follow_redirects=False) as c:
        cfg = c.get("/device-config").json()
        assert (cfg["device"], cfg["sound"], cfg["wake"]) == ("dev", True, True)
        r = c.get("/auth/login", params={"next": "/?enroll=pos"})
        assert (r.status_code, r.headers["location"]) == (302, "/?enroll=pos")
        with c.websocket_connect("/ws", headers={"Origin": "http://elsewhere"}) as ws:
            ws.send_json({"type": "hello", "version": __version__})
            assert ws.receive_json()["type"] == "hello_ok"
