"""Durable Supabase-backed worker."""

import asyncio
import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pajara.analysis import build_descriptive_analysis
from pajara.config import Settings
from pajara.domain import AnalysisResult
from pajara.providers import ExtractionProvider, build_provider
from pajara.reports import build_export_archive, render_analysis_report
from pajara.supabase import SupabaseClient

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, settings: Settings, provider: ExtractionProvider | None = None) -> None:
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise ValueError("Supabase service configuration is required for the worker")
        self.settings = settings
        self.client = SupabaseClient(settings.supabase_url, settings.supabase_service_role_key)
        self.provider = provider or build_provider(settings)

    async def run(self) -> None:
        while True:
            jobs = await self.client.rpc(
                "claim_jobs",
                {"worker_name": self.settings.worker_name, "claim_limit": 1},
            )
            if not jobs:
                if self.settings.worker_once:
                    return
                await asyncio.sleep(self.settings.worker_poll_seconds)
                continue
            await self.process(jobs[0])
            if self.settings.worker_once:
                return

    async def process(self, job: dict[str, Any]) -> None:
        try:
            result = await self._dispatch(job)
            await self.client.update(
                "jobs",
                f"id=eq.{job['id']}",
                {
                    "state": "succeeded",
                    "progress": 100,
                    "result": result,
                    "lease_owner": None,
                    "lease_expires_at": None,
                    "error": None,
                },
            )
        except Exception as exc:
            logger.exception("Job %s failed with %s", job.get("id"), type(exc).__name__)
            attempts = int(job.get("attempts", 1))
            max_attempts = int(job.get("max_attempts", 3))
            retry = attempts < max_attempts
            if not retry and job.get("job_type") == "extraction":
                event_id = job.get("payload", {}).get("event_id")
                if event_id:
                    try:
                        await self.client.update(
                            "events",
                            f"id=eq.{event_id}&user_id=eq.{job['user_id']}",
                            {"trust_status": "trusted"},
                        )
                    except Exception:
                        logger.exception(
                            "Could not restore failed extraction target to trusted manual data"
                        )
            await self.client.update(
                "jobs",
                f"id=eq.{job['id']}",
                {
                    "state": "queued" if retry else "failed",
                    "available_at": (
                        datetime.now(UTC) + timedelta(seconds=min(60, 2**attempts))
                    ).isoformat(),
                    "lease_owner": None,
                    "lease_expires_at": None,
                    "error": f"{type(exc).__name__}: processing failed",
                },
            )

    async def _dispatch(self, job: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "extraction": self._extract,
            "analysis": self._analyze,
            "report": self._report,
            "export": self._export,
            "deletion": self._delete,
        }
        handler = handlers.get(job["job_type"])
        if handler is None:
            raise ValueError(f"Unsupported job type: {job['job_type']}")
        return await handler(job)

    async def _extract(self, job: dict[str, Any]) -> dict[str, Any]:
        event_id = job["payload"]["event_id"]
        events = await self.client.select("events", query=f"select=*&id=eq.{event_id}&limit=1")
        if not events:
            raise ValueError("Target event does not exist")
        event = events[0]
        source_text = str(event.get("attributes", {}).get("original_text", "")).strip()
        provenance = "parsed_text"

        artifact_id = job["payload"].get("artifact_id")
        if not source_text and artifact_id:
            artifacts = await self.client.select(
                "artifacts", query=f"select=*&id=eq.{artifact_id}&limit=1"
            )
            if not artifacts:
                raise ValueError("Target artifact does not exist")
            artifact = artifacts[0]
            content = await self.client.download(artifact["bucket"], artifact["object_path"])
            source_text = await asyncio.to_thread(
                self.provider.transcribe,
                artifact.get("original_filename") or "voice-note",
                artifact["media_type"],
                content,
            )
            provenance = "transcribed"

        run = await self.client.insert(
            "extraction_runs",
            {
                "user_id": job["user_id"],
                "event_id": event_id,
                "artifact_id": artifact_id,
                "provider": self.provider.name,
                "model": self.provider.model,
                "prompt_version": "extract-v1",
                "schema_version": 1,
                "status": "running",
                "started_at": datetime.now(UTC).isoformat(),
            },
        )
        proposal = await asyncio.to_thread(self.provider.extract, event["type_code"], source_text)
        assertions = []
        for item in proposal.assertions:
            row = item.model_dump(mode="json")
            assertions.append(
                {
                    "user_id": job["user_id"],
                    "extraction_run_id": run["id"],
                    "target_kind": "event",
                    "target_id": event_id,
                    "field_path": row["field_path"],
                    "proposed_value": row["proposed_value"],
                    "confidence": row["confidence"],
                    "evidence": {"text": row["evidence"]},
                    "provenance_method": provenance
                    if row["provenance_method"] == "parsed_text"
                    else row["provenance_method"],
                }
            )
        if assertions:
            await self.client.insert("field_assertions", assertions, single=False)
        await self.client.update(
            "extraction_runs",
            f"id=eq.{run['id']}",
            {
                "status": "succeeded",
                "raw_response": proposal.model_dump(mode="json"),
                "completed_at": datetime.now(UTC).isoformat(),
            },
        )
        await self.client.update(
            "events",
            f"id=eq.{event_id}",
            {"trust_status": "pending_review" if assertions else "trusted"},
        )
        return {
            "extraction_run_id": run["id"],
            "assertion_count": len(assertions),
            "summary": proposal.summary,
        }

    async def _analyze(self, job: dict[str, Any]) -> dict[str, Any]:
        run_id = job["payload"]["analysis_run_id"]
        runs = await self.client.select("analysis_runs", query=f"select=*&id=eq.{run_id}&limit=1")
        if not runs:
            raise ValueError("Analysis run does not exist")
        user_id = job["user_id"]
        events = await self.client.select(
            "events",
            query=f"select=*&user_id=eq.{user_id}&trust_status=eq.trusted&order=occurred_start.asc",
        )
        observations = await self.client.select(
            "observations",
            query=f"select=*&user_id=eq.{user_id}&trust_status=eq.trusted&order=observed_at.asc",
        )
        result = build_descriptive_analysis(events, observations)
        await self.client.update(
            "analysis_runs",
            f"id=eq.{run_id}",
            {
                "status": "insufficient_data"
                if result.evidence_strength == "insufficient"
                else "succeeded",
                "result": result.model_dump(mode="json"),
                "limitations": result.limitations,
                "diagnostics": {
                    "trusted_events": len(events),
                    "trusted_observations": len(observations),
                },
                "evidence_strength": result.evidence_strength,
                "completed_at": datetime.now(UTC).isoformat(),
            },
        )
        return {"analysis_run_id": run_id, "evidence_strength": result.evidence_strength}

    async def _report(self, job: dict[str, Any]) -> dict[str, Any]:
        run_id = job["payload"]["analysis_run_id"]
        runs = await self.client.select("analysis_runs", query=f"select=*&id=eq.{run_id}&limit=1")
        if not runs or not runs[0].get("result"):
            raise ValueError("Completed analysis result is required")
        run = runs[0]
        result = AnalysisResult.model_validate(run["result"])
        content = render_analysis_report(result, run.get("question")).encode()
        report_file_id = str(uuid4())
        path = f"{job['user_id']}/reports/{run_id}-{report_file_id}.html"
        await self.client.upload("derived-private", path, content, "text/html")
        digest = hashlib.sha256(content).hexdigest()
        artifact = await self.client.insert(
            "artifacts",
            {
                "user_id": job["user_id"],
                "bucket": "derived-private",
                "object_path": path,
                "sha256": digest,
                "media_type": "text/html",
                "byte_size": len(content),
                "original_filename": "pajara-report.html",
                "artifact_kind": "report",
            },
        )
        report = await self.client.insert(
            "reports",
            {
                "user_id": job["user_id"],
                "analysis_run_id": run_id,
                "artifact_id": artifact["id"],
                "summary": (
                    "Observational personal tracking report; not diagnostic and not causal."
                ),
            },
        )
        return {"report_id": report["id"], "artifact_id": artifact["id"]}

    async def _export(self, job: dict[str, Any]) -> dict[str, Any]:
        user_id = job["user_id"]
        table_names = [
            "profiles",
            "events",
            "observations",
            "event_relations",
            "artifacts",
            "record_artifacts",
            "record_revisions",
            "extraction_runs",
            "field_assertions",
            "event_concepts",
            "concepts",
            "concept_aliases",
            "concept_relations",
            "compositions",
            "jobs",
            "analysis_runs",
            "reports",
        ]
        tables = {
            table: await self.client.select(
                table, query=f"select=*&user_id=eq.{user_id}&order=created_at.asc"
            )
            for table in table_names
        }
        for table in ("concepts", "concept_aliases", "concept_relations", "compositions"):
            tables[table] = await self.client.select(
                table,
                query=(f"select=*&or=(user_id.eq.{user_id},user_id.is.null)&order=created_at.asc"),
            )
        extra_files: dict[str, bytes] = {}
        if job["payload"].get("include_originals", True):
            for artifact in tables["artifacts"]:
                if artifact["bucket"] not in {
                    "skin-originals",
                    "voice-originals",
                    "input-originals",
                }:
                    continue
                original = await self.client.download(artifact["bucket"], artifact["object_path"])
                filename = str(artifact.get("original_filename") or artifact["id"]).replace(
                    "/", "-"
                )
                extra_files[f"originals/{artifact['id']}-{filename}"] = original
        content = build_export_archive(user_id, tables, extra_files)
        export_id = str(uuid4())
        path = f"{user_id}/exports/{export_id}.zip"
        await self.client.upload("derived-private", path, content, "application/zip")
        artifact = await self.client.insert(
            "artifacts",
            {
                "user_id": user_id,
                "bucket": "derived-private",
                "object_path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "media_type": "application/zip",
                "byte_size": len(content),
                "original_filename": "pajara-export.zip",
                "artifact_kind": "export",
                "metadata": {"includes_originals": bool(extra_files)},
            },
        )
        return {"artifact_id": artifact["id"], "bucket": "derived-private", "path": path}

    async def _delete(self, job: dict[str, Any]) -> dict[str, Any]:
        user_id = job["user_id"]
        scope = job["payload"]["scope"]
        if scope == "event":
            event_id = job["payload"]["event_id"]
            links = await self.client.select(
                "record_artifacts",
                query=(
                    f"select=artifact_id,artifacts(id,bucket,object_path)&event_id=eq.{event_id}"
                ),
            )
            for link in links:
                artifact = link.get("artifacts")
                if artifact:
                    await self.client.remove(artifact["bucket"], [artifact["object_path"]])
                    await self.client.delete("artifacts", f"id=eq.{artifact['id']}")
            await self.client.delete("events", f"id=eq.{event_id}&user_id=eq.{user_id}")
            return {"deleted_scope": "event", "event_id": event_id}

        artifacts = await self.client.select(
            "artifacts", query=f"select=id,bucket,object_path&user_id=eq.{user_id}"
        )
        by_bucket: dict[str, list[str]] = {}
        for artifact in artifacts:
            by_bucket.setdefault(artifact["bucket"], []).append(artifact["object_path"])
        for bucket, paths in by_bucket.items():
            await self.client.remove(bucket, paths)
        await self.client.rpc(
            "delete_user_tracking_data",
            {"target_user": user_id, "preserve_job": job["id"]},
        )
        return {"deleted_scope": "all_tracking_data"}
