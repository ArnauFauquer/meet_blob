import asyncio

import httpx
import pytest

from blob.hermes import SYSTEM_MESSAGE, HermesClient, HermesFail, HermesTimeout
from tests.conftest import eventually
from tests.fakes.fake_hermes import MARKDOWN_REPLY, FakeHermes, make_app


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


def client(
    fake: FakeHermes | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    clock: Clock | None = None,
    total_s: float = 75,
) -> HermesClient:
    return HermesClient(
        "http://hermes.test",
        "secret",
        "hermes-agent",
        connect_s=5,
        total_s=total_s,
        session_idle_s=300,
        alerts_url="http://blob.test",
        clock=clock or Clock(),
        transport=transport or httpx.ASGITransport(app=make_app(fake or FakeHermes())),
    )


async def test_request_body_and_headers() -> None:
    fake = FakeHermes()
    reply = await client(fake).ask("¿Qué hora es?")
    assert reply == "Has dicho: ¿Qué hora es?. Es una respuesta de prueba."
    [req] = fake.requests
    assert req["headers"]["authorization"] == "Bearer secret"
    assert req["headers"]["x-hermes-session-id"] == "blob-1000000"
    [system, user] = req["body"].pop("messages")
    assert req["body"] == {"model": "hermes-agent", "stream": False}
    assert user == {"role": "user", "content": "¿Qué hora es?"}
    assert system["role"] == "system"
    content = system["content"]
    # The skill ships inside Blob: base rules, then the skill with the alerts URL filled in.
    assert content.startswith(SYSTEM_MESSAGE)
    assert "# Skill: how Blob works" in content
    assert "{alerts_url}" not in content
    assert "-X POST http://blob.test/alerts" in content
    assert "epoch 1000000, UTC offset" in content


async def test_session_kept_then_rotated_after_idle() -> None:
    fake, clock = FakeHermes(), Clock()
    c = client(fake, clock=clock)
    await c.ask("uno")
    clock.now += 299
    await c.ask("dos")  # within 5 minutes of the last turn: same session, only the new message
    clock.now += 299
    await c.ask("tres")
    clock.now += 300
    await c.ask("cuatro")  # 5 minutes without a turn: new session
    ids = [r["headers"]["x-hermes-session-id"] for r in fake.requests]
    assert ids == ["blob-1000000"] * 3 + [f"blob-{1_000_000 + 898}"]
    assert all(len(r["body"]["messages"]) == 2 for r in fake.requests)


async def test_markdown_reply_returned_raw() -> None:
    assert await client(FakeHermes(mode="markdown")).ask("x") == MARKDOWN_REPLY


@pytest.mark.parametrize("mode", ["error", "empty"])
async def test_error_status_and_empty_reply_fail(mode: str) -> None:
    with pytest.raises(HermesFail):
        await client(FakeHermes(mode=mode)).ask("x")


async def test_unreadable_reply_fails() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    with pytest.raises(HermesFail, match="unreadable"):
        await client(transport=httpx.MockTransport(handler)).ask("x")


async def test_connect_timeout_is_hermes_fail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow connect", request=request)

    with pytest.raises(HermesFail, match="connect timeout"):
        await client(transport=httpx.MockTransport(handler)).ask("x")


async def test_connection_refused_is_hermes_fail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(HermesFail):
        await client(transport=httpx.MockTransport(handler)).ask("x")


async def test_read_timeout_is_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(HermesTimeout):
        await client(transport=httpx.MockTransport(handler)).ask("x")


async def test_total_timeout_is_timeout() -> None:
    with pytest.raises(HermesTimeout):
        await client(FakeHermes(delay=5), total_s=0.05).ask("x")


async def test_cancel_propagates() -> None:
    fake = FakeHermes(delay=5)
    task = asyncio.create_task(client(fake).ask("x"))
    await eventually(lambda: fake.requests)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_reachable() -> None:
    assert await client().reachable() is True

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert await client(transport=httpx.MockTransport(down)).reachable() is False

    def bad(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    c = client(transport=httpx.MockTransport(bad))
    assert await c.reachable() is False
    await c.aclose()
