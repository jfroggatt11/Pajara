"""Descriptive analysis tests."""

from datetime import UTC, datetime, timedelta

from pajara.analysis import build_descriptive_analysis


def test_small_dataset_is_reported_as_insufficient() -> None:
    now = datetime(2026, 7, 29, tzinfo=UTC)
    events = [
        {
            "type_code": "meal",
            "occurred_start": (now - timedelta(hours=4)).isoformat(),
        }
    ]
    observations = [
        {
            "type_code": "itching",
            "numeric_value": 5,
            "observed_at": now.isoformat(),
        }
    ]

    result = build_descriptive_analysis(events, observations, now=now)

    assert result.evidence_strength == "insufficient"
    assert result.symptom_means == {"itching": 5.0}
    assert result.exposure_counts == {"meal": 1}
    assert any("cannot establish causation" in item for item in result.limitations)


def test_recent_change_compares_seven_days_with_preceding_baseline() -> None:
    now = datetime(2026, 7, 29, tzinfo=UTC)
    observations = [
        {
            "type_code": "redness",
            "numeric_value": 2,
            "observed_at": (now - timedelta(days=14)).isoformat(),
        },
        {
            "type_code": "redness",
            "numeric_value": 6,
            "observed_at": (now - timedelta(days=1)).isoformat(),
        },
    ]

    result = build_descriptive_analysis([], observations, now=now)

    assert result.recent_change == {"redness": 4.0}
