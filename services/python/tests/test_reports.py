"""Report and export tests."""

import hashlib
import io
import json
import zipfile
from uuid import uuid4

from pajara.domain import AnalysisResult
from pajara.reports import build_export_archive, render_analysis_report


def test_report_preserves_medical_boundary_and_escapes_question() -> None:
    result = AnalysisResult(
        symptom_observation_count=4,
        event_count=2,
        completeness_days=2,
        symptom_means={"itching": 4.5},
        recent_change={},
        exposure_counts={"meal": 2},
        evidence_strength="insufficient",
        limitations=["Too little data"],
        alternatives=["Natural fluctuation"],
    )

    report = render_analysis_report(result, "<script>alert(1)</script>")

    assert "<script>" not in report
    assert "does not diagnose" in report
    assert "Do not change medication" in report


def test_export_manifest_checksums_match_files() -> None:
    user_id = str(uuid4())
    content = build_export_archive(user_id, {"events": [{"id": "one", "attributes": {}}]})

    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        for item in manifest["files"]:
            assert hashlib.sha256(archive.read(item["path"])).hexdigest() == item["sha256"]
