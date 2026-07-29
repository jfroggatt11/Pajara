"""Job creation and ownership helpers."""

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from fastapi import HTTPException, status

from pajara.domain import UserIdentity
from pajara.supabase import SupabaseClient


async def ensure_owned(
    client: SupabaseClient,
    table: str,
    record_id: UUID,
) -> dict[str, Any]:
    rows = await client.select(table, query=f"select=*&id=eq.{record_id}&limit=1")
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    return cast("dict[str, Any]", rows[0])


async def enqueue_job(
    client: SupabaseClient,
    user: UserIdentity,
    job_type: str,
    payload: dict[str, Any],
    idempotency_key: str | None,
) -> dict[str, Any]:
    key = idempotency_key or f"{job_type}:{uuid4()}"
    return cast(
        "dict[str, Any]",
        await client.insert(
            "jobs",
            {
                "user_id": str(user.user_id),
                "job_type": job_type,
                "payload": payload,
                "state": "queued",
                "available_at": datetime.now(UTC).isoformat(),
                "idempotency_key": key,
            },
        ),
    )
