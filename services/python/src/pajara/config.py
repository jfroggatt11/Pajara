"""Runtime configuration loaded from environment variables."""

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Pajara service settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: str = "development"
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: str = "http://localhost:5173"

    supabase_url: str | None = None
    supabase_publishable_key: str | None = None
    supabase_secret_key: str | None = None
    # Legacy JWT key. New deployments should use SUPABASE_SECRET_KEY.
    supabase_service_role_key: str | None = None
    supabase_jwt_issuer: str | None = None
    supabase_jwt_audience: str = "authenticated"
    supabase_jwt_secret: str | None = None

    openai_api_key: str | None = None
    # Routine text extraction is deliberately assigned to the inexpensive model.
    # Label OCR gets a separate, stronger vision-capable model.
    openai_extraction_model: str = "gpt-4.1-mini"
    openai_product_label_model: str = "gpt-5.4-mini"
    openai_transcription_model: str = "gpt-4o-mini-transcribe"
    extraction_provider: str = "fake"

    worker_name: str = "pajara-worker"
    worker_poll_seconds: float = Field(default=2.0, ge=0.25, le=60)
    worker_once: bool = False
    run_worker_in_api: bool = False
    code_version: str = "0.1.0"

    @model_validator(mode="after")
    def derive_supabase_values(self) -> "Settings":
        if self.supabase_url:
            base = self.supabase_url.rstrip("/")
            self.supabase_url = base
            if not self.supabase_jwt_issuer:
                self.supabase_jwt_issuer = f"{base}/auth/v1"
        return self

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def supabase_admin_key(self) -> str | None:
        return self.supabase_secret_key or self.supabase_service_role_key

    @property
    def backend_ready(self) -> bool:
        return bool(
            self.supabase_url
            and self.supabase_publishable_key
            and self.supabase_admin_key
            and self.supabase_jwt_issuer
        )


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide validated settings."""
    return Settings()
