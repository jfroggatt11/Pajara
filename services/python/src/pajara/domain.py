"""Shared domain models for API requests and extraction results."""

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

JobType = Literal[
    "extraction",
    "catalogue_extraction",
    "capture_extraction",
    "search_index",
    "analysis",
    "report",
    "export",
    "deletion",
]


class UserIdentity(BaseModel):
    """Identity extracted from a verified Supabase JWT."""

    user_id: UUID
    email: str | None = None
    token: str


class ExtractionJobRequest(BaseModel):
    event_id: UUID
    artifact_id: UUID | None = None
    force_transcription: bool = False


class CatalogueExtractionJobRequest(BaseModel):
    concept_id: UUID
    artifact_id: UUID


class CaptureExtractionJobRequest(BaseModel):
    capture_session_id: UUID
    mode: Literal["activity", "food_label", "quick_log"] = "activity"
    operation: Literal["synthesize", "refine"] = "synthesize"
    correction_message_id: UUID | None = None


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


class IngredientProposal(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    confidence: float = Field(ge=0, le=1)
    evidence: str = Field(max_length=500)


class ProductLabelProposal(BaseModel):
    product_name: str | None = Field(default=None, max_length=240)
    product_name_confidence: float | None = Field(default=None, ge=0, le=1)
    product_name_evidence: str | None = Field(default=None, max_length=500)
    brand: str | None = Field(default=None, max_length=240)
    brand_confidence: float | None = Field(default=None, ge=0, le=1)
    brand_evidence: str | None = Field(default=None, max_length=500)
    variant: str | None = Field(default=None, max_length=240)
    variant_confidence: float | None = Field(default=None, ge=0, le=1)
    variant_evidence: str | None = Field(default=None, max_length=500)
    ingredients: list[IngredientProposal] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class CaptureIngredientProposal(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    confidence: float = Field(ge=0, le=1)
    evidence: str = Field(default="", max_length=500)
    basis: list[Literal["visible", "spoken", "matched_recipe", "personal_pattern"]] = Field(
        default_factory=list
    )


class ActivityCaptureProposal(BaseModel):
    activity_type: Literal[
        "meal",
        "meal_preparation",
        "skin_contact",
        "product_use",
        "topical_treatment",
        "medication",
        "activity",
        "note",
    ]
    label: str = Field(min_length=1, max_length=240)
    ingredients: list[CaptureIngredientProposal] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class CaptureProposalBundle(BaseModel):
    activities: list[ActivityCaptureProposal] = Field(min_length=1, max_length=12)
    warnings: list[str] = Field(default_factory=list)


class QuickLogIngredient(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    evidence: str = Field(default="", max_length=500)


class QuickLogImageRole(BaseModel):
    artifact_order: int = Field(ge=0)
    role: Literal[
        "unclassified",
        "meal_photo",
        "ingredient_label",
        "product_front",
        "recipe_document",
        "activity_photo",
        "other",
    ]
    evidence: str = Field(default="", max_length=500)


class QuickLogContact(BaseModel):
    mode: Literal["none", "direct", "gloves", "unknown"] = "unknown"
    items: list[str] = Field(default_factory=list)
    body_areas: list[str] = Field(default_factory=list)


class QuickLogSynthesis(BaseModel):
    """One proposed occurrence synthesized from all capture evidence."""

    occurrence_type: Literal[
        "meal",
        "drink",
        "product",
        "cream",
        "medication",
        "exercise",
        "shower",
        "washing",
        "swimming",
        "other",
    ]
    name: str = Field(min_length=1, max_length=240)
    ingredients: list[QuickLogIngredient] = Field(default_factory=list)
    prepared_by_user: bool | None = None
    action: str | None = Field(default=None, max_length=240)
    products: list[str] = Field(default_factory=list)
    document_relationship: Literal[
        "eaten_directly", "used_as_ingredient", "handled_or_applied", "unrelated", "unknown"
    ] = "unknown"
    skin_contact: QuickLogContact = Field(default_factory=QuickLogContact)
    image_roles: list[QuickLogImageRole] = Field(default_factory=list)
    possible_occurrences: list[str] = Field(default_factory=list, max_length=6)
    warnings: list[str] = Field(default_factory=list)


class QuickLogFieldUpdate(BaseModel):
    field_key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    proposed_value: Any
    explanation: str = Field(default="Updated from your correction.", max_length=500)


class QuickLogRefinement(BaseModel):
    updates: list[QuickLogFieldUpdate] = Field(default_factory=list, max_length=12)


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
