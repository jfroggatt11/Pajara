"""Extraction provider contract tests."""

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
