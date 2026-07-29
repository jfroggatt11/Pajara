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


async def test_run_once_claims_and_processes_one_job() -> None:
    job = {"id": "job-one", "job_type": "analysis"}
    worker = RecordingWorker([job])

    assert await worker.run_once() is True
    assert worker.processed == [job]


async def test_run_once_returns_false_when_queue_is_empty() -> None:
    worker = RecordingWorker([])

    assert await worker.run_once() is False
    assert worker.processed == []
