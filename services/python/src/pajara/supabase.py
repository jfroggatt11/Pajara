"""Small async client for Supabase Data and Storage APIs."""

from typing import Any
from urllib.parse import quote

import httpx


class SupabaseError(RuntimeError):
    """Raised when a Supabase API request fails."""


class SupabaseClient:
    def __init__(self, url: str, api_key: str, bearer_token: str | None = None) -> None:
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.bearer_token = bearer_token or api_key

    @property
    def headers(self) -> dict[str, str]:
        return {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json",
        }

    async def select(
        self,
        table: str,
        *,
        query: str = "select=*",
        single: bool = False,
    ) -> Any:
        headers = self.headers
        if single:
            headers["Accept"] = "application/vnd.pgrst.object+json"
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{self.url}/rest/v1/{table}?{query}", headers=headers)
        return self._json(response)

    async def insert(self, table: str, payload: Any, *, single: bool = True) -> Any:
        headers = {
            **self.headers,
            "Prefer": "return=representation",
        }
        if single:
            headers["Accept"] = "application/vnd.pgrst.object+json"
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.url}/rest/v1/{table}",
                headers=headers,
                json=payload,
            )
        return self._json(response)

    async def update(self, table: str, filters: str, payload: dict[str, Any]) -> Any:
        headers = {**self.headers, "Prefer": "return=representation"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.patch(
                f"{self.url}/rest/v1/{table}?{filters}",
                headers=headers,
                json=payload,
            )
        return self._json(response)

    async def delete(self, table: str, filters: str) -> Any:
        headers = {**self.headers, "Prefer": "return=representation"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.delete(
                f"{self.url}/rest/v1/{table}?{filters}",
                headers=headers,
            )
        return self._json(response)

    async def rpc(self, name: str, payload: dict[str, Any]) -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.url}/rest/v1/rpc/{name}",
                headers=self.headers,
                json=payload,
            )
        return self._json(response)

    async def download(self, bucket: str, path: str) -> bytes:
        safe_path = quote(path, safe="/")
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(
                f"{self.url}/storage/v1/object/{bucket}/{safe_path}",
                headers=self.headers,
            )
        if response.is_error:
            raise SupabaseError(f"Storage download failed ({response.status_code})")
        return response.content

    async def upload(
        self,
        bucket: str,
        path: str,
        content: bytes,
        media_type: str,
    ) -> None:
        safe_path = quote(path, safe="/")
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": media_type,
            "x-upsert": "false",
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{self.url}/storage/v1/object/{bucket}/{safe_path}",
                headers=headers,
                content=content,
            )
        if response.is_error:
            raise SupabaseError(f"Storage upload failed ({response.status_code})")

    async def remove(self, bucket: str, paths: list[str]) -> None:
        if not paths:
            return
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.request(
                "DELETE",
                f"{self.url}/storage/v1/object/{bucket}",
                headers=self.headers,
                json={"prefixes": paths},
            )
        if response.is_error:
            raise SupabaseError(f"Storage deletion failed ({response.status_code})")

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        if response.is_error:
            detail = response.text[:500]
            raise SupabaseError(f"Supabase request failed ({response.status_code}): {detail}")
        if not response.content:
            return None
        return response.json()
