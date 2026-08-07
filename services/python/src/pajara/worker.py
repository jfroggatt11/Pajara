"""Durable Supabase-backed worker."""

import asyncio
import hashlib
import logging
import re
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
        if not settings.supabase_url or not settings.supabase_admin_key:
            raise ValueError("Supabase service configuration is required for the worker")
        self.settings = settings
        self.client = SupabaseClient(settings.supabase_url, settings.supabase_admin_key)
        self.provider = provider or build_provider(settings)

    async def run(self) -> None:
        while True:
            processed = await self.run_once()
            if not processed:
                if self.settings.worker_once:
                    return
                await asyncio.sleep(self.settings.worker_poll_seconds)
                continue
            if self.settings.worker_once:
                return

    async def run_once(self) -> bool:
        """Atomically claim and process at most one queued job."""
        jobs = await self.client.rpc(
            "claim_jobs",
            {"worker_name": self.settings.worker_name, "claim_limit": 1},
        )
        if not jobs:
            return False
        await self.process(jobs[0])
        return True

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
            if not retry and job.get("job_type") == "catalogue_extraction":
                extraction_id = job.get("payload", {}).get("catalogue_extraction_id")
                if extraction_id:
                    try:
                        await self.client.update(
                            "catalogue_extractions",
                            f"id=eq.{extraction_id}&user_id=eq.{job['user_id']}",
                            {
                                "status": "failed",
                                "error": f"{type(exc).__name__}: processing failed",
                                "completed_at": datetime.now(UTC).isoformat(),
                            },
                        )
                    except Exception:
                        logger.exception("Could not mark catalogue extraction as failed")
            if not retry and job.get("job_type") == "capture_extraction":
                capture_id = job.get("payload", {}).get("capture_session_id")
                if capture_id:
                    try:
                        await self.client.update(
                            "capture_sessions",
                            f"id=eq.{capture_id}&user_id=eq.{job['user_id']}",
                            {
                                "status": "failed",
                                "error": f"{type(exc).__name__}: processing failed",
                            },
                        )
                    except Exception:
                        logger.exception("Could not mark capture extraction as failed")
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
            "catalogue_extraction": self._extract_catalogue,
            "capture_extraction": self._extract_capture,
            "analysis": self._analyze,
            "report": self._report,
            "export": self._export,
            "deletion": self._delete,
        }
        handler = handlers.get(job["job_type"])
        if handler is None:
            raise ValueError(f"Unsupported job type: {job['job_type']}")
        return await handler(job)

    @staticmethod
    def _match_score(query: str, candidate: str) -> float:
        def tokens(value: str) -> set[str]:
            return {token for token in re.findall(r"[a-z0-9]+", value.lower()) if len(token) > 1}

        query_tokens = tokens(query)
        candidate_tokens = tokens(candidate)
        if not query_tokens or not candidate_tokens:
            return 0.0
        if query.strip().lower() == candidate.strip().lower():
            return 1.0
        return len(query_tokens & candidate_tokens) / len(query_tokens | candidate_tokens)

    async def _recipe_context(self, user_id: str) -> list[dict[str, Any]]:
        recipes = await self.client.select(
            "recipes",
            query=f"select=*&user_id=eq.{user_id}&archived_at=is.null&order=updated_at.desc",
        )
        if not recipes:
            return []
        recipe_ids = ",".join(str(recipe["id"]) for recipe in recipes)
        versions = await self.client.select(
            "recipe_versions",
            query=(f"select=*&recipe_id=in.({recipe_ids})&order=version_number.desc"),
        )
        if not versions:
            return []
        version_by_recipe = {
            str(version["recipe_id"]): version
            for version in versions
            if version.get("effective_to") is None
        }
        version_ids = ",".join(str(version["id"]) for version in versions)
        components = await self.client.select(
            "recipe_components",
            query=(
                "select=*&recipe_version_id=in.("
                f"{version_ids})&review_state=in.(accepted,corrected)&order=component_order.asc"
            ),
        )
        food_ids = sorted({str(row["component_food_item_id"]) for row in components})
        foods: list[dict[str, Any]] = []
        if food_ids:
            foods = await self.client.select(
                "food_items",
                query=f"select=id,canonical_name&id=in.({','.join(food_ids)})",
            )
        food_names = {str(food["id"]): str(food["canonical_name"]) for food in foods}
        components_by_version: dict[str, list[dict[str, Any]]] = {}
        for row in components:
            components_by_version.setdefault(str(row["recipe_version_id"]), []).append(row)

        def leaf_items(version_id: str, path: frozenset[str] = frozenset()) -> list[dict[str, str]]:
            if version_id in path or len(path) >= 32:
                return []
            leaves: list[dict[str, str]] = []
            for component in components_by_version.get(version_id, []):
                nested_version_id = component.get("source_recipe_version_id")
                if nested_version_id:
                    leaves.extend(leaf_items(str(nested_version_id), path | {version_id}))
                    continue
                food_id = str(component["component_food_item_id"])
                name = food_names.get(food_id)
                if name:
                    leaves.append({"id": food_id, "name": name})
            return leaves

        context: list[dict[str, Any]] = []
        for recipe in recipes:
            version = version_by_recipe.get(str(recipe["id"]))
            if not version:
                continue
            leaves = leaf_items(str(version["id"]))
            deduplicated_leaves = list({leaf["id"]: leaf for leaf in leaves}.values())
            context.append(
                {
                    "recipe_id": recipe["id"],
                    "recipe_version_id": version["id"],
                    "recipe_version_number": version["version_number"],
                    "output_food_item_id": recipe["output_food_item_id"],
                    "name": recipe["name"],
                    "ingredients": [leaf["name"] for leaf in deduplicated_leaves],
                    "ingredient_items": deduplicated_leaves,
                    "instructions": version.get("instructions") or "",
                    "last_used_at": recipe.get("attributes", {}).get("last_used_at"),
                }
            )
        return context

    async def _concept_context(self, user_id: str) -> list[dict[str, Any]]:
        concepts = await self.client.select(
            "concepts",
            query=(
                "select=id,concept_type,canonical_name,attributes&"
                f"user_id=eq.{user_id}&archived_at=is.null&"
                "concept_type=in.(product,medication,treatment,activity)&order=updated_at.desc"
            ),
        )
        if not concepts:
            return []
        concept_ids = ",".join(str(concept["id"]) for concept in concepts)
        versions = await self.client.select(
            "concept_versions",
            query=(
                "select=id,concept_id,version_number&effective_to=is.null&concept_id=in.("
                f"{concept_ids})&order=version_number.desc"
            ),
        )
        version_by_concept = {str(version["concept_id"]): version for version in versions}
        return [
            {
                "concept_id": concept["id"],
                "concept_version_id": version_by_concept.get(str(concept["id"]), {}).get("id"),
                "concept_type": concept["concept_type"],
                "name": concept["canonical_name"],
                "attributes": concept.get("attributes", {}),
            }
            for concept in concepts
        ]

    @staticmethod
    def _candidate_concept_types(activity_type: str) -> set[str]:
        return {
            "skin_contact": {"product", "treatment"},
            "product_use": {"product", "treatment"},
            "topical_treatment": {"treatment", "product"},
            "medication": {"medication"},
            "activity": {"activity"},
        }.get(activity_type, set())

    async def _extract_capture(self, job: dict[str, Any]) -> dict[str, Any]:
        if job["payload"].get("mode", "activity") == "food_label":
            return await self._extract_food_label_capture(job)

        capture_id = job["payload"]["capture_session_id"]
        rows = await self.client.select(
            "capture_sessions", query=f"select=*&id=eq.{capture_id}&limit=1"
        )
        if not rows:
            raise ValueError("Capture session does not exist")
        capture = rows[0]
        await self.client.update(
            "capture_sessions",
            f"id=eq.{capture_id}",
            {
                "status": "processing",
                "provider": self.provider.name,
                "model": getattr(self.provider, "capture_model", self.provider.model),
                "prompt_version": "activity-capture-v1",
            },
        )

        artifact: dict[str, Any] | None = None
        content: bytes | None = None
        if capture.get("artifact_id"):
            artifacts = await self.client.select(
                "artifacts", query=f"select=*&id=eq.{capture['artifact_id']}&limit=1"
            )
            if not artifacts:
                raise ValueError("Capture artifact does not exist")
            artifact = artifacts[0]
            content = await self.client.download(artifact["bucket"], artifact["object_path"])

        source_text = str(capture.get("transcript") or capture.get("original_text") or "").strip()
        if (
            capture["source_type"] == "voice"
            and not source_text
            and artifact
            and content is not None
        ):
            source_text = (
                await asyncio.to_thread(
                    self.provider.transcribe,
                    artifact.get("original_filename") or "voice-note",
                    artifact["media_type"],
                    content,
                )
            ).strip()
            await self.client.update(
                "capture_sessions", f"id=eq.{capture_id}", {"transcript": source_text}
            )

        generic = await asyncio.to_thread(
            self.provider.extract_capture,
            capture["source_type"],
            source_text,
            artifact.get("media_type") if artifact else None,
            content if capture["source_type"] == "photo" else None,
            None,
        )
        recipe_context = await self._recipe_context(job["user_id"])
        concept_context = await self._concept_context(job["user_id"])
        personalized = generic
        if capture["source_type"] == "photo" and recipe_context:
            personalized = await asyncio.to_thread(
                self.provider.extract_capture,
                capture["source_type"],
                source_text,
                artifact.get("media_type") if artifact else None,
                content,
                recipe_context[:12],
            )

        await self.client.delete("activity_proposals", f"capture_session_id=eq.{capture_id}")
        candidate_count = 0
        for index, activity in enumerate(personalized.activities, start=1):
            generic_activity = generic.activities[min(index - 1, len(generic.activities) - 1)]
            proposal = await self.client.insert(
                "activity_proposals",
                {
                    "user_id": job["user_id"],
                    "capture_session_id": capture_id,
                    "proposal_order": index,
                    "activity_type": activity.activity_type,
                    "label": activity.label,
                    "generic_guess": generic_activity.model_dump(mode="json"),
                    "personalized_guess": activity.model_dump(mode="json"),
                    "warnings": activity.warnings,
                },
            )
            if activity.activity_type == "meal":
                ingredient_text = " ".join(item.name for item in activity.ingredients)
                query_text = f"{activity.label} {ingredient_text}"
                ranked: list[tuple[float, dict[str, Any]]] = []
                for context in recipe_context:
                    candidate_text = f"{context['name']} {' '.join(context.get('ingredients', []))}"
                    score = self._match_score(query_text, candidate_text)
                    if activity.label.lower() == str(context["name"]).lower():
                        score = 1.0
                    ranked.append((score, context))
                ranked.sort(key=lambda item: item[0], reverse=True)
                for candidate_order, (score, context) in enumerate(ranked[:8], start=1):
                    await self.client.insert(
                        "proposal_candidates",
                        {
                            "user_id": job["user_id"],
                            "activity_proposal_id": proposal["id"],
                            "candidate_order": candidate_order,
                            "candidate_kind": "recipe",
                            "recipe_id": context["recipe_id"],
                            "score": min(1.0, max(0.05, score)),
                            "score_breakdown": {"text_and_ingredient_overlap": score},
                            "explanation": (
                                f"Saved dish with {len(context.get('ingredients', []))} "
                                "confirmed ingredients."
                            ),
                            "snapshot": context,
                        },
                    )
                    candidate_count += 1
            else:
                allowed_types = self._candidate_concept_types(activity.activity_type)
                ranked_concepts = [
                    (self._match_score(activity.label, str(context["name"])), context)
                    for context in concept_context
                    if context["concept_type"] in allowed_types
                ]
                ranked_concepts.sort(key=lambda item: item[0], reverse=True)
                for candidate_order, (score, context) in enumerate(ranked_concepts[:8], start=1):
                    await self.client.insert(
                        "proposal_candidates",
                        {
                            "user_id": job["user_id"],
                            "activity_proposal_id": proposal["id"],
                            "candidate_order": candidate_order,
                            "candidate_kind": "concept",
                            "concept_id": context["concept_id"],
                            "score": min(1.0, max(0.05, score)),
                            "score_breakdown": {"label_overlap": score},
                            "explanation": (
                                f"Saved {str(context['concept_type']).replace('_', ' ')}."
                            ),
                            "snapshot": context,
                        },
                    )
                    candidate_count += 1

        await self.client.update(
            "capture_sessions",
            f"id=eq.{capture_id}",
            {"status": "ready", "error": None},
        )
        return {
            "capture_session_id": capture_id,
            "proposal_count": len(personalized.activities),
            "candidate_count": candidate_count,
        }

    async def _extract_food_label_capture(self, job: dict[str, Any]) -> dict[str, Any]:
        capture_id = job["payload"]["capture_session_id"]
        rows = await self.client.select(
            "capture_sessions", query=f"select=*&id=eq.{capture_id}&limit=1"
        )
        if not rows:
            raise ValueError("Capture session does not exist")
        capture = rows[0]
        if not capture.get("artifact_id"):
            raise ValueError("A food label photo is required")

        artifacts = await self.client.select(
            "artifacts", query=f"select=*&id=eq.{capture['artifact_id']}&limit=1"
        )
        if not artifacts:
            raise ValueError("Capture artifact does not exist")
        artifact = artifacts[0]
        await self.client.update(
            "capture_sessions",
            f"id=eq.{capture_id}",
            {
                "status": "processing",
                "provider": self.provider.name,
                "model": self.provider.product_label_model,
                "prompt_version": "food-label-v1",
            },
        )
        content = await self.client.download(artifact["bucket"], artifact["object_path"])
        proposal = await asyncio.to_thread(
            self.provider.extract_product_label,
            artifact["media_type"],
            content,
        )
        serialized = proposal.model_dump(mode="json")
        attributes = {
            **(capture.get("attributes") or {}),
            "food_label_proposal": serialized,
        }
        await self.client.update(
            "capture_sessions",
            f"id=eq.{capture_id}",
            {"status": "ready", "attributes": attributes, "error": None},
        )
        return {
            "capture_session_id": capture_id,
            "ingredient_count": len(proposal.ingredients),
            "warning_count": len(proposal.warnings),
        }

    async def _extract_catalogue(self, job: dict[str, Any]) -> dict[str, Any]:
        extraction_id = job["payload"]["catalogue_extraction_id"]
        rows = await self.client.select(
            "catalogue_extractions",
            query=f"select=*&id=eq.{extraction_id}&limit=1",
        )
        if not rows:
            raise ValueError("Catalogue extraction does not exist")
        extraction = rows[0]
        artifacts = await self.client.select(
            "artifacts",
            query=f"select=*&id=eq.{extraction['artifact_id']}&limit=1",
        )
        if not artifacts:
            raise ValueError("Catalogue label artifact does not exist")
        artifact = artifacts[0]
        await self.client.update(
            "catalogue_extractions",
            f"id=eq.{extraction_id}",
            {
                "status": "running",
                "started_at": datetime.now(UTC).isoformat(),
                "provider": self.provider.name,
                "model": self.provider.product_label_model,
            },
        )
        content = await self.client.download(artifact["bucket"], artifact["object_path"])
        proposal = await asyncio.to_thread(
            self.provider.extract_product_label,
            artifact["media_type"],
            content,
        )
        serialized = proposal.model_dump(mode="json")
        await self.client.update(
            "catalogue_extractions",
            f"id=eq.{extraction_id}",
            {
                "status": "succeeded",
                "proposal": serialized,
                "raw_response": serialized,
                "completed_at": datetime.now(UTC).isoformat(),
            },
        )
        return {
            "catalogue_extraction_id": extraction_id,
            "ingredient_count": len(proposal.ingredients),
            "warning_count": len(proposal.warnings),
        }

    async def _extract(self, job: dict[str, Any]) -> dict[str, Any]:
        event_id = job["payload"]["event_id"]
        events = await self.client.select("events", query=f"select=*&id=eq.{event_id}&limit=1")
        if not events:
            raise ValueError("Target event does not exist")
        event = events[0]
        source_text = str(event.get("attributes", {}).get("original_text", "")).strip()
        provenance = "parsed_text"
        transcribed_text: str | None = None

        artifact_id = job["payload"].get("artifact_id")
        if artifact_id and (not source_text or bool(job["payload"].get("force_transcription"))):
            artifacts = await self.client.select(
                "artifacts", query=f"select=*&id=eq.{artifact_id}&limit=1"
            )
            if not artifacts:
                raise ValueError("Target artifact does not exist")
            artifact = artifacts[0]
            content = await self.client.download(artifact["bucket"], artifact["object_path"])
            transcribed_text = (
                await asyncio.to_thread(
                    self.provider.transcribe,
                    artifact.get("original_filename") or "voice-note",
                    artifact["media_type"],
                    content,
                )
            ).strip()
            source_text = "\n".join(part for part in [source_text, transcribed_text] if part)
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
        if transcribed_text:
            assertions.append(
                {
                    "user_id": job["user_id"],
                    "extraction_run_id": run["id"],
                    "target_kind": "event",
                    "target_id": event_id,
                    "field_path": "/attributes/original_text",
                    "proposed_value": source_text,
                    "confidence": 0.0,
                    "evidence": {
                        "text": "Transcript proposed from the original voice recording; "
                        "confidence is unavailable."
                    },
                    "provenance_method": "transcribed",
                }
            )
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
            "catalogue_extractions",
            "capture_sessions",
            "activity_proposals",
            "proposal_candidates",
            "event_concepts",
            "food_items",
            "food_item_aliases",
            "recipes",
            "recipe_versions",
            "recipe_components",
            "food_batches",
            "concept_search_documents",
            "concepts",
            "concept_aliases",
            "concept_relations",
            "concept_versions",
            "concept_artifacts",
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
        for table in (
            "concepts",
            "concept_aliases",
            "concept_relations",
            "compositions",
            "food_items",
            "food_item_aliases",
        ):
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
