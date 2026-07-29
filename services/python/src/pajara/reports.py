"""Safe report and portable export generation."""

import csv
import hashlib
import io
import json
import zipfile
from datetime import UTC, datetime
from html import escape
from typing import Any

from pajara.domain import AnalysisResult


def render_analysis_report(result: AnalysisResult, question: str | None = None) -> str:
    """Render a self-contained, non-diagnostic HTML report."""
    title = escape(question or "Personal dermatitis tracking summary")
    means = "".join(
        f"<li>{escape(name.title())}: {value:.2f}/10</li>"
        for name, value in sorted(result.symptom_means.items())
    )
    changes = "".join(
        f"<li>{escape(name.title())}: {value:+.2f} versus the preceding baseline</li>"
        for name, value in sorted(result.recent_change.items())
    )
    limitations = "".join(f"<li>{escape(item)}</li>" for item in result.limitations)
    alternatives = "".join(f"<li>{escape(item)}</li>" for item in result.alternatives)
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{title}</title>
<style>body{{font:16px/1.6 system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}}
.notice{{padding:1rem;border:1px solid #b7791f;background:#fffaf0;color:#3d2b0b}}</style></head>
<body>
<h1>{title}</h1>
<p class="notice">This report tracks patterns. It does not diagnose a condition or
establish that an exposure caused symptoms. Do not change medication based on it.</p>
<p>Evidence strength: <strong>{escape(result.evidence_strength.replace("_", " "))}</strong></p>
<p>{result.symptom_observation_count} symptom observations across
{result.completeness_days} observed days; {result.event_count} events.</p>
<h2>Average recorded symptoms</h2><ul>{means or "<li>Not enough data</li>"}</ul>
<h2>Recent change</h2><ul>{changes or "<li>Not enough baseline data</li>"}</ul>
<h2>Alternative explanations</h2><ul>{alternatives}</ul>
<h2>Limitations</h2><ul>{limitations}</ul>
</body></html>"""


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, indent=2, default=str, ensure_ascii=False).encode()


def build_export_archive(
    user_id: str,
    tables: dict[str, list[dict[str, Any]]],
    extra_files: dict[str, bytes] | None = None,
) -> bytes:
    """Build an export ZIP containing JSONL, CSV conveniences, and checksums."""
    files: dict[str, bytes] = dict(extra_files or {})
    for name, rows in tables.items():
        files[f"records/{name}.jsonl"] = b"".join(
            json.dumps(row, default=str, ensure_ascii=False).encode() + b"\n" for row in rows
        )

        if rows:
            output = io.StringIO()
            fields = sorted({key for row in rows for key in row})
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            for row in rows:
                writer.writerow(
                    {
                        key: json.dumps(value, default=str)
                        if isinstance(value, (dict, list))
                        else value
                        for key, value in row.items()
                    }
                )
            files[f"tables/{name}.csv"] = output.getvalue().encode()

    manifest = {
        "format_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "user_id": user_id,
        "files": [
            {
                "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
            }
            for path, content in sorted(files.items())
        ],
    }
    files["manifest.json"] = _json_bytes(manifest)
    files["README.txt"] = (
        b"Pajara personal data export. JSONL is the full-fidelity structured format. "
        b"CSV files are provided for convenience.\n"
    )

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output_zip:
        for path, content in files.items():
            output_zip.writestr(path, content)
    return archive.getvalue()
