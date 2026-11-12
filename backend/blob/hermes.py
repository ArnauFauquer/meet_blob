"""Hermes Agent client (OpenAI-compatible /v1/chat/completions) with session history."""

import asyncio
import time
from collections.abc import Callable

import httpx

SYSTEM_MESSAGE = (
    "You are Blob, a voice assistant in a home. Your reply is spoken aloud. "
    "Answer in short spoken sentences. Do not use markdown, lists, emoji or links. "
    "Reply in the language of the user's last message; if it is Catalan, reply in Spanish. "
    "Before any action that changes something, ask the user to confirm."
)


class HermesFail(Exception):
    """Connect failure, connect timeout, error status or unreadable reply: reason hermes_fail."""


class HermesTimeout(Exception):
    """The total timeout passed: reason timeout, timeout_kind hermes."""


class HermesClient:
    def __init__(
        self,
        url: str,
        key: str,
        model: str,
        connect_s: float,
        total_s: float,
        session_idle_s: float,
        clock: Callable[[], float] = time.time,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url, self._model = url, model
        self._total_s, self._idle_s, self._clock = total_s, session_idle_s, clock
        self._http = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {key}"},
            timeout=httpx.Timeout(total_s, connect=connect_s),
            transport=transport,
        )
        self._session: str | None = None
        self._last_turn = 0.0

    def session_id(self) -> str:
        """blob-<unix time of the last rotation>; rotated after session_idle_s without a turn."""
        now = self._clock()
        if self._session is None or now - self._last_turn >= self._idle_s:
            self._session = f"blob-{int(now)}"
        self._last_turn = now
        return self._session

    async def ask(self, user_text: str) -> str:
        """Return the reply text. Cancelling the calling task closes the HTTP request."""
        body = {
            "model": self._model,
            "stream": False,
            "messages": [
                {"role": "system", "content": SYSTEM_MESSAGE},
                {"role": "user", "content": user_text},
            ],
        }
        headers = {"X-Hermes-Session-Id": self.session_id()}
        try:
            async with asyncio.timeout(self._total_s):
                r = await self._http.post(
                    f"{self._url}/v1/chat/completions", json=body, headers=headers
                )
        except TimeoutError as e:
            raise HermesTimeout() from e
        except httpx.ConnectTimeout as e:
            raise HermesFail("connect timeout") from e
        except httpx.TimeoutException as e:
            raise HermesTimeout() from e
        except httpx.HTTPError as e:
            raise HermesFail(type(e).__name__) from e
        if r.status_code != 200:
            raise HermesFail(f"status {r.status_code}")
        try:
            content = r.json()["choices"][0]["message"]["content"]
        except (ValueError, LookupError, TypeError) as e:
            raise HermesFail("unreadable reply") from e
        if not isinstance(content, str) or not content.strip():
            raise HermesFail("empty reply")
        return content

    async def reachable(self) -> bool:
        try:
            r = await self._http.get(f"{self._url}/health", timeout=3)
        except httpx.HTTPError:
            return False
        return r.status_code == 200

    async def aclose(self) -> None:
        await self._http.aclose()
