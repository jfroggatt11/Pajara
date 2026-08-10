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


def test_quick_log_synthesizes_exactly_one_occurrence_from_mixed_evidence() -> None:
    proposal = FakeExtractionProvider().synthesize_quick_log(
        [
            {
                "artifact_order": 0,
                "media_type": "image/jpeg",
                "content": b"meal-photo",
            },
            {
                "artifact_order": 1,
                "media_type": "audio/webm",
                "text": "I cooked tomato pasta",
            },
        ],
        {},
    )

    assert proposal.occurrence_type == "meal"
    assert proposal.prepared_by_user is True
    assert proposal.possible_occurrences == []
    serialized = proposal.model_dump(mode="json")
    assert "duration" not in str(serialized)
    assert "quantity" not in str(serialized)
    assert "dose" not in str(serialized)


def test_quick_log_refinement_can_update_multiple_existing_cards() -> None:
    refinement = FakeExtractionProvider().refine_quick_log(
        {
            "occurrence_type": "meal",
            "identity": {"name": "Pasta", "mode": "existing"},
            "preparation_contact": {
                "prepared_by_user": True,
                "skin_contact": {"mode": "direct", "items": ["tomato"]},
            },
        },
        "This was named Tomato pasta and there was no skin contact",
    )

    assert {update.field_key for update in refinement.updates} == {
        "identity",
        "preparation_contact",
    }
    contact_update = next(
        update for update in refinement.updates if update.field_key == "preparation_contact"
    )
    assert contact_update.proposed_value["skin_contact"]["mode"] == "none"
