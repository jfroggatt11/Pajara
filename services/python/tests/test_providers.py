"""Extraction provider contract tests."""

from pajara.config import Settings
from pajara.providers import FakeExtractionProvider


def test_fake_provider_detects_explicit_meal_preparation() -> None:
    proposal = FakeExtractionProvider().extract(
        "meal",
        "I made pasta and chopped raw tomatoes with bare hands.",
    )

    assertion = next(
        item for item in proposal.assertions if item.field_path == "/attributes/prepared_by_user"
    )
    assert assertion.proposed_value is True
    assert assertion.confidence <= 1
    assert proposal.warnings


def test_fake_provider_does_not_diagnose() -> None:
    proposal = FakeExtractionProvider().extract("note", "My hands were itchy after washing.")
    serialized = proposal.model_dump_json().lower()

    assert "diagnos" not in serialized
    assert "caused by" not in serialized


def test_fake_label_provider_preserves_review_boundary() -> None:
    proposal = FakeExtractionProvider().extract_product_label("image/jpeg", b"not-an-image")

    assert proposal.ingredients == []
    assert proposal.warnings


def test_low_cost_openai_model_defaults_are_separated_by_task() -> None:
    settings = Settings()

    assert settings.openai_extraction_model == "gpt-4.1-mini"
    assert settings.openai_product_label_model == "gpt-5.4-mini"
    assert settings.openai_capture_model == "gpt-5.4-mini"
    assert settings.openai_transcription_model == "gpt-4o-mini-transcribe"


def test_photo_capture_keeps_generic_guess_separate_from_saved_recipe_context() -> None:
    provider = FakeExtractionProvider()

    generic = provider.extract_capture("photo", "", "image/jpeg", b"photo", None)
    personalized = provider.extract_capture(
        "photo",
        "",
        "image/jpeg",
        b"photo",
        [{"name": "Tomato pasta", "ingredients": ["Tomato", "Pasta"]}],
    )

    assert generic.activities[0].label == "Photographed meal"
    assert generic.activities[0].ingredients == []
    assert personalized.activities[0].label == "Tomato pasta"
    assert [item.name for item in personalized.activities[0].ingredients] == [
        "Tomato",
        "Pasta",
    ]
    assert personalized.activities[0].ingredients[0].basis == ["matched_recipe"]
