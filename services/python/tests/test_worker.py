"""Worker claim behavior tests."""

from typing import Any, cast

from pajara.config import Settings
from pajara.domain import IngredientProposal, ProductLabelProposal
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


class LabelProvider(FakeExtractionProvider):
    def extract_product_label(self, media_type: str, content: bytes) -> ProductLabelProposal:
        assert media_type == "image/jpeg"
        assert content == b"label"
        return ProductLabelProposal(
            product_name="Test wash",
            brand="Example",
            ingredients=[
                IngredientProposal(name="Water", confidence=0.99, evidence="Water"),
                IngredientProposal(name="Glycerin", confidence=0.91, evidence="Glycerin"),
            ],
        )


class CatalogueExtractionClient:
    def __init__(self) -> None:
        self.updates: list[tuple[str, str, dict[str, Any]]] = []

    async def select(self, table: str, query: str = "") -> list[dict[str, Any]]:
        if table == "catalogue_extractions":
            return [{"id": "extract-one", "artifact_id": "artifact-one"}]
        if table == "artifacts":
            return [
                {
                    "id": "artifact-one",
                    "bucket": "input-originals",
                    "object_path": "user/product/label.jpg",
                    "media_type": "image/jpeg",
                }
            ]
        raise AssertionError(f"Unexpected select table: {table}")

    async def download(self, bucket: str, path: str) -> bytes:
        assert bucket == "input-originals"
        assert path == "user/product/label.jpg"
        return b"label"

    async def update(self, table: str, query: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self.updates.append((table, query, payload))
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
    extraction_client = ExtractionClient()
    worker.client = cast(SupabaseClient, extraction_client)
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

    assertions = extraction_client.inserted["field_assertions"]
    transcript = assertions[0]
    assert transcript["field_path"] == "/attributes/original_text"
    assert transcript["proposed_value"] == "made lunch\nhandled raw tomato"
    assert transcript["provenance_method"] == "transcribed"
    assert result["assertion_count"] == len(assertions)


async def test_catalogue_label_extraction_stays_a_proposal() -> None:
    worker = object.__new__(Worker)
    worker.settings = Settings()
    extraction_client = CatalogueExtractionClient()
    worker.client = cast(SupabaseClient, extraction_client)
    worker.provider = LabelProvider()

    result = await worker._extract_catalogue(
        {
            "user_id": "user-one",
            "payload": {"catalogue_extraction_id": "extract-one"},
        }
    )

    final_update = extraction_client.updates[-1][2]
    assert final_update["status"] == "succeeded"
    assert final_update["proposal"]["ingredients"][0]["name"] == "Water"
    assert result["ingredient_count"] == 2
