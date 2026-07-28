"""Command-line entry point for the local Pajara server."""

import argparse
from collections.abc import Sequence

import uvicorn


def build_parser() -> argparse.ArgumentParser:
    """Build the server command-line parser."""
    parser = argparse.ArgumentParser(description="Run the local Pajara web application")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default: loopback)")
    parser.add_argument("--port", default=8000, type=int, help="port to bind (default: 8000)")
    parser.add_argument("--reload", action="store_true", help="reload when source files change")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """Run Pajara using safe local defaults."""
    args = build_parser().parse_args(argv)
    uvicorn.run(
        "pajara.app:create_app",
        host=args.host,
        port=args.port,
        factory=True,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
