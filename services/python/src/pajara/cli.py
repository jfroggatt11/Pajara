"""Command-line entry points for API and worker process modes."""

import argparse
import asyncio
import logging
from collections.abc import Sequence

import uvicorn

from pajara.config import get_settings
from pajara.worker import Worker


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a Pajara service process")
    subcommands = parser.add_subparsers(dest="command")

    api = subcommands.add_parser("api", help="run the authenticated HTTP API")
    api.add_argument("--host", default=None)
    api.add_argument("--port", default=None, type=int)
    api.add_argument("--reload", action="store_true")

    worker = subcommands.add_parser("worker", help="run the durable background worker")
    worker.add_argument("--once", action="store_true", help="process at most one job")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    command = args.command or "api"
    settings = get_settings()

    if command == "worker":
        logging.basicConfig(level=logging.INFO)
        if args.once:
            settings.worker_once = True
        asyncio.run(Worker(settings).run())
        return

    uvicorn.run(
        "pajara.app:create_app",
        host=args.host or settings.api_host,
        port=args.port or settings.api_port,
        factory=True,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
