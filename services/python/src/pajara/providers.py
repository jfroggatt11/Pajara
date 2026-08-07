"""Provider-isolated AI extraction, label reading, and transcription."""

import base64
import re
from abc import ABC, abstractmethod
from typing import Any, Literal, cast

from openai import OpenAI
from openai.types.responses import ResponseInputParam

from pajara.config import Settings
from pajara.domain import (
    ActivityCaptureProposal,
    CaptureIngredientProposal,
    CaptureProposalBundle,
    ExtractionProposal,
    ProductLabelProposal,
    ProposedAssertion,
)

EXTRACTION_INSTRUCTIONS = """
You organize personal dermatitis tracking inputs into proposed structured fields.
Do not diagnose a condition, infer a medical cause, rate a skin photo clinically, or
recommend treatment changes. Preserve uncertainty. Return only fields directly
supported by the input and include a short evidence excerpt for each assertion.
For meals, distinguish food consumed from ingredients actually handled. Never assume
that every recipe ingredient touched skin. Use field paths /label or
/attributes/<snake_case_key>. Confidence is extraction confidence, not trigger
probability.
""".strip()

PRODUCT_LABEL_INSTRUCTIONS = """
Read a photographed personal-care, household, treatment, or medication product label,
or a photographed meal, recipe, or recipe ingredient list. Extract only text that is
visibly supported by the image and preserve ingredient order. Do not expand
abbreviations by guessing, infer hidden ingredients, infer that an ingredient touched
the user's skin, diagnose a condition, or recommend starting, stopping, or changing
treatment. Use confidence to describe transcription certainty only. Put unreadable or
ambiguous areas in warnings.
""".strip()

CAPTURE_INSTRUCTIONS = """
Convert a personal activity photo or transcript into reviewable activity proposals.
Never diagnose, infer a medical cause, or silently assert uncertain facts. A single
capture may describe several distinct activities, such as exercise, showering and
applying a cream. Keep food ingestion and food-preparation skin contact separate.
For a meal photograph, ingredient names are hypotheses: distinguish visible evidence
from ingredients suggested by the supplied personal recipe context. Do not claim a
personal-pattern ingredient is visible. Return only structured proposals for human
confirmation.
""".strip()


class ExtractionProvider(ABC):
    name: str
    model: str

    @property
    def product_label_model(self) -> str:
        return self.model

    @abstractmethod
    def extract(self, event_type: str, source_text: str) -> ExtractionProposal:
        """Extract a structured proposal from source text."""

    def transcribe(self, filename: str, media_type: str, content: bytes) -> str:
        raise RuntimeError("Transcription is not supported by this provider")

    def extract_product_label(self, media_type: str, content: bytes) -> ProductLabelProposal:
        raise RuntimeError("Image label extraction is not supported by this provider")

    def extract_capture(
        self,
        source_type: str,
        source_text: str,
        media_type: str | None,
        content: bytes | None,
        knowledge_context: list[dict[str, Any]] | None = None,
    ) -> CaptureProposalBundle:
        raise RuntimeError("Activity capture extraction is not supported by this provider")


class FakeExtractionProvider(ExtractionProvider):
    """Deterministic provider used locally and in tests."""

    name = "fake"
    model = "deterministic-v1"

    def extract(self, event_type: str, source_text: str) -> ExtractionProposal:
        normalized = " ".join(source_text.split())
        label = normalized[:80] or event_type.replace("_", " ").title()
        assertions = [
            ProposedAssertion(
                field_path="/label",
                proposed_value=label,
                confidence=0.95,
                evidence=normalized[:120] or "User-selected event type",
            ),
            ProposedAssertion(
                field_path="/attributes/ai_summary",
                proposed_value=normalized or f"Manual {event_type} entry",
                confidence=0.9,
                evidence=normalized[:160] or "No free text supplied",
            ),
        ]

        if event_type in {"meal", "meal_preparation"}:
            prepared = bool(
                re.search(r"\b(made|prepared|cooked|chopped|baked|mixed)\b", normalized, re.I)
            )
            assertions.append(
                ProposedAssertion(
                    field_path="/attributes/prepared_by_user",
                    proposed_value=prepared,
                    confidence=0.75 if prepared else 0.45,
                    evidence=normalized[:160] or "No preparation wording found",
                )
            )

        return ExtractionProposal(
            summary=f"Draft structure for {event_type.replace('_', ' ')}",
            assertions=assertions,
            warnings=["Review every proposed field before trusting it."],
        )

    def extract_product_label(self, media_type: str, content: bytes) -> ProductLabelProposal:
        del media_type, content
        return ProductLabelProposal(
            warnings=[
                "The deterministic development provider cannot read images. "
                "Enter the label manually or configure the vision provider."
            ]
        )

    def extract_capture(
        self,
        source_type: str,
        source_text: str,
        media_type: str | None,
        content: bytes | None,
        knowledge_context: list[dict[str, Any]] | None = None,
    ) -> CaptureProposalBundle:
        del media_type, content
        normalized = " ".join(source_text.split())
        if source_type == "photo":
            context = knowledge_context or []
            if context:
                first = context[0]
                ingredients = [
                    CaptureIngredientProposal(
                        name=str(name),
                        confidence=0.5,
                        evidence="Suggested by the leading saved dish.",
                        basis=["matched_recipe"],
                    )
                    for name in first.get("ingredients", [])
                ]
                return CaptureProposalBundle(
                    activities=[
                        ActivityCaptureProposal(
                            activity_type="meal",
                            label=str(first.get("name") or "Photographed meal"),
                            ingredients=ingredients,
                            warnings=["Development mode cannot inspect the photograph."],
                        )
                    ]
                )
            return CaptureProposalBundle(
                activities=[
                    ActivityCaptureProposal(
                        activity_type="meal",
                        label="Photographed meal",
                        warnings=[
                            "Development mode cannot inspect the photograph; choose a saved dish "
                            "or enter one manually."
                        ],
                    )
                ]
            )

        parts = [
            part.strip()
            for part in re.split(r"(?:\bthen\b|[.;]|\band\s+then\b)", normalized, flags=re.I)
            if part.strip()
        ] or [normalized or "Manual activity"]
        activities: list[ActivityCaptureProposal] = []
        for part in parts[:12]:
            lowered = part.lower()
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
            if re.search(r"\b(ate|meal|breakfast|lunch|dinner|food|drank|drink)\b", lowered):
                activity_type = "meal"
            elif re.search(r"\b(cream|ointment|lotion|moistur)\w*\b", lowered):
                activity_type = "topical_treatment"
            elif re.search(r"\b(medicine|medication|tablet|pill|dose)\b", lowered):
                activity_type = "medication"
            elif re.search(r"\b(shower|bath|ran|run|running|exercise|swam|swim)\b", lowered):
                activity_type = "activity"
            else:
                activity_type = "note"
            activities.append(
                ActivityCaptureProposal(activity_type=activity_type, label=part[:240])
            )
        return CaptureProposalBundle(activities=activities)


class OpenAIExtractionProvider(ExtractionProvider):
    name = "openai"

    def __init__(self, settings: Settings) -> None:
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for the OpenAI provider")
        self.client = OpenAI(api_key=settings.openai_api_key)
        self.model = settings.openai_extraction_model
        self._product_label_model = settings.openai_product_label_model
        self.capture_model = settings.openai_capture_model
        self.transcription_model = settings.openai_transcription_model

    @property
    def product_label_model(self) -> str:
        return self._product_label_model

    def extract(self, event_type: str, source_text: str) -> ExtractionProposal:
        response = self.client.responses.parse(
            model=self.model,
            instructions=EXTRACTION_INSTRUCTIONS,
            input=f"Event type: {event_type}\nOriginal user input:\n{source_text}",
            text_format=ExtractionProposal,
        )
        if response.output_parsed is None:
            raise RuntimeError("The extraction model returned no validated proposal")
        return response.output_parsed

    def transcribe(self, filename: str, media_type: str, content: bytes) -> str:
        transcript: Any = self.client.audio.transcriptions.create(
            model=self.transcription_model,
            file=(filename, content, media_type),
        )
        return str(transcript.text)

    def extract_product_label(self, media_type: str, content: bytes) -> ProductLabelProposal:
        encoded = base64.b64encode(content).decode("ascii")
        request_input = cast(
            "ResponseInputParam",
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "Extract the visible saved-item name and ordered ingredient "
                                "list from this product label, meal, or recipe image."
                            ),
                        },
                        {
                            "type": "input_image",
                            "image_url": f"data:{media_type};base64,{encoded}",
                        },
                    ],
                }
            ],
        )
        response = self.client.responses.parse(
            model=self.product_label_model,
            instructions=PRODUCT_LABEL_INSTRUCTIONS,
            input=request_input,
            text_format=ProductLabelProposal,
        )
        if response.output_parsed is None:
            raise RuntimeError("The label extraction model returned no validated proposal")
        return response.output_parsed

    def extract_capture(
        self,
        source_type: str,
        source_text: str,
        media_type: str | None,
        content: bytes | None,
        knowledge_context: list[dict[str, Any]] | None = None,
    ) -> CaptureProposalBundle:
        context_text = (
            "No personal recipe context is supplied. Make a generic guess only."
            if knowledge_context is None
            else (
                "Only use the following private, retrieved recipe candidates as uncertain "
                f"personal context:\n{knowledge_context}"
            )
        )
        content_parts: list[dict[str, Any]] = [
            {
                "type": "input_text",
                "text": (
                    f"Capture source: {source_type}\n"
                    f"User text/transcript: {source_text or '(none)'}"
                    f"\n{context_text}"
                ),
            }
        ]
        if content is not None and media_type is not None:
            encoded = base64.b64encode(content).decode("ascii")
            content_parts.append(
                {
                    "type": "input_image",
                    "image_url": f"data:{media_type};base64,{encoded}",
                    "detail": "high",
                }
            )
        request_input = cast(
            "ResponseInputParam",
            [{"role": "user", "content": content_parts}],
        )
        response = self.client.responses.parse(
            model=self.capture_model,
            instructions=CAPTURE_INSTRUCTIONS,
            input=request_input,
            text_format=CaptureProposalBundle,
        )
        if response.output_parsed is None:
            raise RuntimeError("The capture model returned no validated proposal")
        return response.output_parsed


def build_provider(settings: Settings) -> ExtractionProvider:
    if settings.extraction_provider == "openai":
        return OpenAIExtractionProvider(settings)
    return FakeExtractionProvider()
