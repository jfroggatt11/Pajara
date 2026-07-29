"""Supabase JWT verification for authenticated API calls."""

from typing import Annotated, Any
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from jwt.types import Options

from pajara.config import Settings, get_settings
from pajara.domain import UserIdentity

bearer = HTTPBearer(auto_error=False)


def _decode_token(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.supabase_jwt_issuer:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured",
        )

    options: Options = {"require": ["exp", "sub"]}
    if settings.supabase_jwt_secret:
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_jwt_issuer,
            options=options,
        )

    jwks = PyJWKClient(f"{settings.supabase_jwt_issuer}/.well-known/jwks.json")
    signing_key = jwks.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256", "ES256"],
        audience=settings.supabase_jwt_audience,
        issuer=settings.supabase_jwt_issuer,
        options=options,
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> UserIdentity:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required"
        )

    try:
        claims = _decode_token(credentials.credentials, settings)
        return UserIdentity(
            user_id=UUID(claims["sub"]),
            email=claims.get("email"),
            token=credentials.credentials,
        )
    except HTTPException:
        raise
    except (jwt.PyJWTError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc


CurrentUser = Annotated[UserIdentity, Depends(get_current_user)]
