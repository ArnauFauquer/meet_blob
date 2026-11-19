"""Who may talk to Blob.

Browsers sign in with OpenID Connect (oidc.py) and then carry a session cookie: GET /device-config
answers 401 without it and the WebSocket closes with 4401. Machine sources (Hermes, Home
Assistant) send the alert token to /alerts (401 otherwise).
"""

import hashlib
import hmac
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import Header, HTTPException, Request, Response, WebSocket

from .config import Settings
from .db import Db

SESSION_COOKIE = "blob_session"
# Browsers cap cookie lifetimes at 400 days. The server ends idle sessions much sooner
# (SESSION_IDLE_DAYS), so the cookie itself never needs renewing on a kiosk that stays open.
COOKIE_MAX_AGE = 400 * 86400
TOUCH_EVERY_S = 3600  # seen_at is written at most this often per session


def token_ok(presented: str, expected: str) -> bool:
    """Constant-time comparison."""
    return hmac.compare_digest(presented.encode(), expected.encode())


def require_alert_token(request: Request, authorization: str = Header(default="")) -> None:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token_ok(token, request.app.state.settings.alert_token):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Bearer"})


@dataclass(frozen=True)
class User:
    sub: str
    name: str  # shown in diagnostics and logs (preferred_username from the provider)
    groups: tuple[str, ...]


def _hash(session_id: str) -> str:
    return hashlib.sha256(session_id.encode()).hexdigest()


class Sessions:
    """Server-side sessions in SQLite: signing out deletes the row; idle rows expire."""

    def __init__(self, db: Db, idle_days: int, wall: Callable[[], float] = time.time) -> None:
        self._db = db
        self._idle_s = idle_days * 86400
        self._wall = wall

    async def create(self, user: User) -> str:
        session_id = secrets.token_urlsafe(32)
        await self._db.insert_session(
            _hash(session_id), user.sub, user.name, list(user.groups), int(self._wall())
        )
        return session_id

    async def get(self, session_id: str) -> User | None:
        if not session_id:
            return None
        key = _hash(session_id)
        row = await self._db.get_session(key)
        if row is None:
            return None
        now = int(self._wall())
        seen = row["seen_at"]
        if now - seen > self._idle_s:
            await self._db.delete_session(key)
            return None
        if now - seen > TOUCH_EVERY_S:
            await self._db.touch_session(key, now)
        return User(sub=row["sub"], name=row["name"], groups=tuple(map(str, row["groups"])))

    async def delete(self, session_id: str) -> None:
        if session_id:
            await self._db.delete_session(_hash(session_id))

    async def delete_idle(self) -> int:
        return await self._db.delete_idle_sessions(int(self._wall()) - self._idle_s)


def secure_cookies(public_url: str) -> bool:
    return public_url.startswith("https://")


def set_session_cookie(response: Response, session_id: str, public_url: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        max_age=COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        secure=secure_cookies(public_url),
        samesite="lax",
    )


def clear_session_cookie(response: Response, public_url: str) -> None:
    response.delete_cookie(
        SESSION_COOKIE, path="/", httponly=True, secure=secure_cookies(public_url), samesite="lax"
    )


def dev_user(settings: Settings) -> User:
    """Who everyone is when AUTH_DISABLED is on (local development): sound and wake on."""
    return User("dev", "dev", (settings.oidc_sound_group, settings.oidc_wake_group))


async def current_user(request: Request) -> User | None:
    if request.app.state.settings.auth_disabled:
        return dev_user(request.app.state.settings)
    sessions: Sessions = request.app.state.sessions
    return await sessions.get(request.cookies.get(SESSION_COOKIE, ""))


async def require_user(request: Request) -> User:
    user = await current_user(request)
    if user is None:
        raise HTTPException(status_code=401)
    return user


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


async def websocket_user(ws: WebSocket) -> User | None:
    """The session behind a WebSocket upgrade.

    Browsers send cookies with cross-site WebSocket upgrades too, so a browser's Origin must be
    PUBLIC_URL's. Clients without an Origin header (scripts) must present the cookie themselves.
    """
    settings = ws.app.state.settings
    if settings.auth_disabled:
        return dev_user(settings)
    origin = ws.headers.get("origin")
    if origin is not None and origin.lower() != _origin(settings.public_url):
        return None
    sessions: Sessions = ws.app.state.sessions
    return await sessions.get(ws.cookies.get(SESSION_COOKIE, ""))
