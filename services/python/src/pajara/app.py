"""FastAPI application factory for the hosted Pajara service."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware

from pajara.auth import CurrentUser
from pajara.config import Settings, get_settings
from pajara.domain import (
    AnalysisJobRequest,
    CatalogueExtractionJobRequest,
    DeletionJobRequest,
    ExportJobRequest,
    ExtractionJobRequest,
    JobAccepted,
    ReportJobRequest,
)
from pajara.jobs import enqueue_job, ensure_owned
from pajara.supabase import SupabaseClient, SupabaseError
from pajara.worker import Worker


def _user_client(settings: Settings, token: str) -> SupabaseClient:
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase user access is not configured",
        )
    return SupabaseClient(settings.supabase_url, settings.supabase_publishable_key, token)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the Pajara API."""
    active_settings = settings or get_settings()
    inline_worker = Worker(active_settings) if active_settings.run_worker_in_api else None

    def process_queued_job(background_tasks: BackgroundTasks) -> None:
        if inline_worker:
            background_tasks.add_task(inline_worker.run_once)

    app = FastAPI(
        title="Pajara service",
        summary="AI extraction, analysis, reports, and exports",
        version=active_settings.code_version,
        docs_url="/docs" if active_settings.environment != "production" else None,
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=active_settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )

    @app.exception_handler(SupabaseError)
    async def handle_supabase_error(_request: object, exc: SupabaseError) -> Response:
        return Response(
            content='{"detail":"The data service request failed"}',
            status_code=status.HTTP_502_BAD_GATEWAY,
            media_type="application/json",
        )

    @app.get("/health", tags=["operations"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready", tags=["operations"])
    async def ready() -> dict[str, str]:
        if not active_settings.backend_ready:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Required backend configuration is missing",
            )
        return {"status": "ready"}

    @app.post(
        "/v1/jobs/extraction",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_extraction(
        request: ExtractionJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        await ensure_owned(client, "events", request.event_id)
        if request.artifact_id:
            await ensure_owned(client, "artifacts", request.artifact_id)
        job = await enqueue_job(
            client,
            user,
            "extraction",
            request.model_dump(mode="json", exclude_none=True),
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"])

    @app.post(
        "/v1/jobs/analysis",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_analysis(
        request: AnalysisJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        analysis = await client.insert(
            "analysis_runs",
            {
                "user_id": str(user.user_id),
                "question": request.question,
                "specification": request.model_dump(mode="json"),
                "data_cutoff": datetime.now(UTC).isoformat(),
                "status": "queued",
                "code_version": active_settings.code_version,
            },
        )
        job = await enqueue_job(
            client,
            user,
            "analysis",
            {"analysis_run_id": analysis["id"]},
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"], related_id=analysis["id"])

    @app.post(
        "/v1/jobs/catalogue-extraction",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_catalogue_extraction(
        request: CatalogueExtractionJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        concept = await ensure_owned(client, "concepts", request.concept_id)
        if concept.get("user_id") != str(user.user_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Record not found",
            )
        await ensure_owned(client, "artifacts", request.artifact_id)
        extraction = await client.insert(
            "catalogue_extractions",
            {
                "user_id": str(user.user_id),
                "concept_id": str(request.concept_id),
                "artifact_id": str(request.artifact_id),
                "provider": active_settings.extraction_provider,
                "model": (
                    active_settings.openai_product_label_model
                    if active_settings.extraction_provider == "openai"
                    else "deterministic-v1"
                ),
                "prompt_version": "catalogue-image-v2",
                "status": "queued",
            },
        )
        job = await enqueue_job(
            client,
            user,
            "catalogue_extraction",
            {"catalogue_extraction_id": extraction["id"]},
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"], related_id=extraction["id"])

    @app.post(
        "/v1/jobs/report",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_report(
        request: ReportJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        await ensure_owned(client, "analysis_runs", request.analysis_run_id)
        job = await enqueue_job(
            client,
            user,
            "report",
            request.model_dump(mode="json"),
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"], related_id=request.analysis_run_id)

    @app.post(
        "/v1/jobs/export",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_export(
        request: ExportJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        job = await enqueue_job(
            client,
            user,
            "export",
            request.model_dump(mode="json"),
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"])

    @app.post(
        "/v1/jobs/deletion",
        response_model=JobAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def request_deletion(
        request: DeletionJobRequest,
        background_tasks: BackgroundTasks,
        user: CurrentUser,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> JobAccepted:
        client = _user_client(active_settings, user.token)
        expected = "DELETE EVENT" if request.scope == "event" else "DELETE MY PAJARA DATA"
        if request.confirmation != expected:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Deletion confirmation did not match",
            )
        if request.scope == "event":
            if request.event_id is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="event_id is required for event deletion",
                )
            await ensure_owned(client, "events", request.event_id)
        job = await enqueue_job(
            client,
            user,
            "deletion",
            request.model_dump(mode="json", exclude_none=True),
            idempotency_key,
        )
        process_queued_job(background_tasks)
        return JobAccepted(job_id=job["id"], related_id=request.event_id)

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: UUID, user: CurrentUser) -> dict[str, object]:
        client = _user_client(active_settings, user.token)
        job = await ensure_owned(client, "jobs", job_id)
        return job

    return app
