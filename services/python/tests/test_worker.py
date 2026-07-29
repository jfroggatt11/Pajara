"""Worker claim behavior tests."""

from typing import Any

from pajara.config import Settings
from pajara.providers import FakeExtractionProvider
from pajara.supabase import SupabaseClient
from pajara.worker import Worker


class ClaimingClient(SupabaseClient):
    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.jobs = jobs

    async def rpc(self, name: str, payload: dict[str, Any]) -> Any:
        assert name == "claim_jobs"
        assert payload["claim_limit"] == 1
        return self.jobs


class RecordingWorker(Worker):
    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.settings = Settings(worker_name="inline-test")
        self.client = ClaimingClient(jobs)
        self.provider = FakeExtractionProvider()
        self.processed: list[dict[str, Any]] = []

    async def process(self, job: dict[str, Any]) -> None:
        self.processed.append(job)


class TranscribingFakeProvider(FakeExtractionProvider):
    def transcribe(self, filename: str, media_type: str, content: bytes) -> str:
        assert filename == "voice.webm"
        assert media_type == "audio/webm"
        assert content == b"voice"
        return "handled raw tomato"


class ExtractionClient:
    def __init__(self) -> None:
        self.inserted: dict[str, Any] = {}

    async def select(self, table: str, query: str = "") -> list[dict[str, Any]]:
        if table == "events":
            return [
                {
                    "id": "event-one",
                    "type_code": "meal_preparation",
                    "attributes": {"original_text": "made lunch"},
                }
            ]
        if table == "artifacts":
            return [
                {
                    "id": "artifact-one",
                    "bucket": "voice-originals",
                    "object_path": "user/event/voice.webm",
                    "original_filename": "voice.webm",
                    "media_type": "audio/webm",
                }
            ]
        raise AssertionError(f"Unexpected select table: {table}")

    async def download(self, bucket: str, path: str) -> bytes:
        assert bucket == "voice-originals"
        assert path == "user/event/voice.webm"
        return b"voice"

    async def insert(self, table: str, payload: Any, single: bool = True) -> dict[str, Any]:
        self.inserted[table] = payload
        if table == "extraction_runs":
            return {"id": "run-one"}
        return {}

    async def update(self, table: str, query: str, payload: Any) -> list[dict[str, Any]]:
        return []


async def test_run_once_claims_and_processes_one_job() -> None:
    job = {"id": "job-one", "job_type": "analysis"}
    worker = RecordingWorker([job])

    assert await worker.run_once() is True
    assert worker.processed == [job]


async def test_run_once_returns_false_when_queue_is_empty() -> None:
    worker = RecordingWorker([])

    assert await worker.run_once() is False
    assert worker.processed == []


async def test_forced_backend_transcription_is_proposed_for_review() -> None:
    worker = object.__new__(Worker)
    worker.settings = Settings()
    worker.client = ExtractionClient()
    worker.provider = TranscribingFakeProvider()

    result = await worker._extract(
        {
            "user_id": "user-one",
            "payload": {
                "event_id": "event-one",
                "artifact_id": "artifact-one",
                "force_transcription": True,
            },
        }
    )

    assertions = worker.client.inserted["field_assertions"]
    transcript = assertions[0]
    assert transcript["field_path"] == "/attributes/original_text"
    assert transcript["proposed_value"] == "made lunch\nhandled raw tomato"
    assert transcript["provenance_method"] == "transcribed"
    assert result["assertion_count"] == len(assertions)
