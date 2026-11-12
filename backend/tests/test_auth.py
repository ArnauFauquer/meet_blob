from fastapi.testclient import TestClient

from blob.auth import token_ok
from tests.conftest import TOKEN


def test_token_ok() -> None:
    assert token_ok("abc", "abc")
    assert not token_ok("abd", "abc")
    assert not token_ok("", "abc")
    assert token_ok("ñ", "ñ")


def test_device_config_needs_token(client: TestClient) -> None:
    assert client.get("/device-config?device=tablet").status_code == 401
    wrong = {"Authorization": "Bearer nope"}
    assert client.get("/device-config?device=tablet", headers=wrong).status_code == 401
    no_scheme = {"Authorization": TOKEN}
    assert client.get("/device-config?device=tablet", headers=no_scheme).status_code == 401
    ok = {"Authorization": f"Bearer {TOKEN}"}
    assert client.get("/device-config?device=tablet", headers=ok).status_code == 200
