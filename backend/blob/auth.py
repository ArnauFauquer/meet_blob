"""Device token checks: on WebSocket hello (close 4401) and on GET /device-config (401)."""

import hmac

from fastapi import Header, HTTPException, Request


def token_ok(presented: str, expected: str) -> bool:
    """Constant-time comparison."""
    return hmac.compare_digest(presented.encode(), expected.encode())


def require_device_token(request: Request, authorization: str = Header(default="")) -> None:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token_ok(token, request.app.state.settings.device_token):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Bearer"})
