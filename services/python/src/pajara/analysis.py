"""Transparent descriptive analysis for the first prototype."""

from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from statistics import fmean
from typing import Any, Literal

from pajara.domain import AnalysisResult

SYMPTOMS = {"redness", "itching", "dryness", "cracking", "swelling", "pain"}


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def build_descriptive_analysis(
    events: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> AnalysisResult:
    """Build a cautious summary from trusted records only."""
    current = now or datetime.now(UTC)
    symptom_values: dict[str, list[tuple[datetime, float]]] = defaultdict(list)

    for observation in observations:
        type_code = observation.get("type_code")
        value = observation.get("numeric_value")
        observed_at = observation.get("observed_at")
        if type_code in SYMPTOMS and value is not None and observed_at:
            symptom_values[type_code].append((_parse_time(observed_at), float(value)))

    all_points = [point for values in symptom_values.values() for point in values]
    means = {
        symptom: round(fmean(value for _, value in values), 2)
        for symptom, values in symptom_values.items()
        if values
    }

    recent_change: dict[str, float] = {}
    for symptom, values in symptom_values.items():
        recent = [value for time, value in values if time >= current - timedelta(days=7)]
        baseline = [
            value
            for time, value in values
            if current - timedelta(days=30) <= time < current - timedelta(days=7)
        ]
        if recent and baseline:
            recent_change[symptom] = round(fmean(recent) - fmean(baseline), 2)

    exposure_counts = Counter(
        str(event.get("type_code")) for event in events if event.get("type_code") != "skin_check"
    )
    observed_days = {
        time.astimezone(UTC).date() for values in symptom_values.values() for time, _ in values
    }

    limitations = [
        "This is an observational within-person summary and cannot establish causation.",
        "Treatments may be used because symptoms worsened, which can reverse "
        "apparent associations.",
        "Unlogged exposures and symptoms are missing, not evidence that they did not occur.",
    ]
    if len(all_points) < 20:
        limitations.insert(
            0, "There are too few symptom observations for stable trigger comparisons."
        )
    if len(observed_days) < 14:
        limitations.append("Fewer than 14 distinct symptom-observation days are available.")

    evidence: Literal[
        "insufficient", "weak", "suggestive", "stronger_within_person_association"
    ] = "insufficient"
    if len(all_points) >= 20 and len(observed_days) >= 14:
        evidence = "weak"

    times = [
        _parse_time(event["occurred_start"]) for event in events if event.get("occurred_start")
    ]
    times.extend(time for time, _ in all_points)

    return AnalysisResult(
        data_start=min(times) if times else None,
        data_end=max(times) if times else None,
        symptom_observation_count=len(all_points),
        event_count=len(events),
        completeness_days=len(observed_days),
        symptom_means=means,
        recent_change=recent_change,
        exposure_counts=dict(exposure_counts),
        evidence_strength=evidence,
        limitations=limitations,
        alternatives=[
            "Baseline symptom drift or natural fluctuation",
            "Changes in treatment use",
            "Weather, illness, stress, sleep, or travel",
            "Differences in logging frequency or photo conditions",
        ],
    )
