"""Provider-isolated AI extraction, label reading, and transcription."""

import base64
import re
from abc import ABC, abstractmethod
from typing import Any, cast

from openai import OpenAI
from openai.types.responses import ResponseInputParam

from pajara.config import Settings
from pajara.domain import (
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
visibly supported by the image and preserve ingredient order. For a recipe, include a
numeric amount and unit only where both are visibly supported; otherwise leave them
empty. Do not expand abbreviations by guessing, infer hidden ingredients, diagnose a
condition, or recommend starting, stopping, or changing treatment. Use confidence to
describe transcription certainty only. Put unreadable or ambiguous areas in warnings.
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


class OpenAIExtractionProvider(ExtractionProvider):
    name = "openai"

    def __init__(self, settings: Settings) -> None:
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for the OpenAI provider")
        self.client = OpenAI(api_key=settings.openai_api_key)
        self.model = settings.openai_extraction_model
        self._product_label_model = settings.openai_product_label_model
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


def build_provider(settings: Settings) -> ExtractionProvider:
    if settings.extraction_provider == "openai":
        return OpenAIExtractionProvider(settings)
    return FakeExtractionProvider()
