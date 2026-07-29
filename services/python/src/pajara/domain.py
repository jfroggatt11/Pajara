"""Shared domain models for API requests and extraction results."""

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

JobType = Literal["extraction", "analysis", "report", "export", "deletion"]


class UserIdentity(BaseModel):
    """Identity extracted from a verified Supabase JWT."""

    user_id: UUID
    email: str | None = None
    token: str


class ExtractionJobRequest(BaseModel):
    event_id: UUID
    artifact_id: UUID | None = None
    force_transcription: bool = False


class AnalysisJobRequest(BaseModel):
    question: str = Field(default="What changed before recent symptom worsening?", max_length=500)
    window_days: int = Field(default=30, ge=7, le=365)


class ReportJobRequest(BaseModel):
    analysis_run_id: UUID


class ExportJobRequest(BaseModel):
    include_originals: bool = True


class DeletionJobRequest(BaseModel):
    scope: Literal["event", "all_tracking_data"]
    event_id: UUID | None = None
    confirmation: str


class JobAccepted(BaseModel):
    job_id: UUID
    state: str = "queued"
    related_id: UUID | None = None


class Evidence(BaseModel):
    text: str
    source: Literal["text", "transcript", "image", "normalization"] = "text"


class ProposedAssertion(BaseModel):
    field_path: str = Field(pattern=r"^/(attributes/[A-Za-z0-9_-]+|label)$")
    proposed_value: Any
    confidence: float = Field(ge=0, le=1)
    evidence: str
    provenance_method: Literal["manual", "transcribed", "vision", "parsed_text", "normalized"] = (
        "parsed_text"
    )


class ExtractionProposal(BaseModel):
    summary: str
    assertions: list[ProposedAssertion]
    warnings: list[str] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_start: datetime | None = None
    data_end: datetime | None = None
    symptom_observation_count: int
    event_count: int
    completeness_days: int
    symptom_means: dict[str, float]
    recent_change: dict[str, float]
    exposure_counts: dict[str, int]
    lag_windows_hours: list[tuple[int, int]] = Field(
        default_factory=lambda: [(0, 6), (6, 24), (24, 72), (72, 168)]
    )
    evidence_strength: Literal[
        "insufficient", "weak", "suggestive", "stronger_within_person_association"
    ]
    limitations: list[str]
    alternatives: list[str]
