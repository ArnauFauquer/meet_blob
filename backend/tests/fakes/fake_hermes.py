"""A fake Hermes /v1/chat/completions server that records what it receives.

In tests: make_app(...) with httpx.ASGITransport. As a server:
    uv run python tests/fakes/fake_hermes.py --port 8642 [--mode ok|error|markdown] [--delay 0]
GET /requests returns what was recorded; DELETE /requests clears it.
"""

import argparse
import asyncio
from dataclasses import dataclass, field
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

MARKDOWN_REPLY = (
    "**Claro**: aquí tienes 🙂 la [respuesta](https://example.com) en https://example.com/x. "
    "- uno\n- dos"
)


@dataclass
class FakeHermes:
    mode: str = "ok"  # ok | error | markdown | empty
    delay: float = 0.0
    status: int = 500
    requests: list[dict[str, Any]] = field(default_factory=list)

    def reply(self, user_text: str) -> str:
        if self.mode == "markdown":
            return MARKDOWN_REPLY
        if self.mode == "empty":
            return ""
        return f"Has dicho: {user_text}. Es una respuesta de prueba."


def make_app(fake: FakeHermes) -> Starlette:
    async def completions(request: Request) -> Response:
        body = await request.json()
        fake.requests.append({"headers": dict(request.headers), "body": body})
        if fake.delay:
            await asyncio.sleep(fake.delay)
        if fake.mode == "error":
            return JSONResponse({"error": "fake failure"}, status_code=fake.status)
        user = next(m["content"] for m in reversed(body["messages"]) if m["role"] == "user")
        reply = {"role": "assistant", "content": fake.reply(user)}
        return JSONResponse(
            {"id": "fake", "model": body.get("model"), "choices": [{"message": reply}]},
            headers={"X-Hermes-Session-Id": request.headers.get("x-hermes-session-id", "")},
        )

    async def health(_: Request) -> Response:
        return JSONResponse({"status": "ok", "platform": "fake-hermes"})

    async def requests(request: Request) -> Response:
        if request.method == "DELETE":
            fake.requests.clear()
        return JSONResponse({"count": len(fake.requests), "requests": fake.requests})

    return Starlette(
        routes=[
            Route("/v1/chat/completions", completions, methods=["POST"]),
            Route("/health", health),
            Route("/requests", requests, methods=["GET", "DELETE"]),
        ]
    )


if __name__ == "__main__":
    import uvicorn

    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8642)
    p.add_argument("--mode", default="ok", choices=["ok", "error", "markdown", "empty"])
    p.add_argument("--delay", type=float, default=0.0)
    a = p.parse_args()
    uvicorn.run(make_app(FakeHermes(mode=a.mode, delay=a.delay)), host="127.0.0.1", port=a.port)
