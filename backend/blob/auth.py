"""Bearer token checks: the device token on WebSocket hello (close 4401) and on
GET /device-config (401), and the alert token on /alerts (401)."""

import hmac

from fastapi import Header, HTTPException, Request


def token_ok(presented: str, expected: str) -> bool:
    """Constant-time comparison."""
    return hmac.compare_digest(presented.encode(), expected.encode())


def _require_bearer(authorization: str, expected: str) -> None:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token_ok(token, expected):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Bearer"})


def require_device_token(request: Request, authorization: str = Header(default="")) -> None:
    _require_bearer(authorization, request.app.state.settings.device_token)


def require_alert_token(request: Request, authorization: str = Header(default="")) -> None:
    _require_bearer(authorization, request.app.state.settings.alert_token)
