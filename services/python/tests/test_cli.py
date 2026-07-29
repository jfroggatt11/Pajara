"""Command-line configuration tests."""

from pajara.cli import build_parser


def test_api_command_accepts_host_and_port() -> None:
    args = build_parser().parse_args(["api", "--host", "127.0.0.1", "--port", "8765"])

    assert args.command == "api"
    assert args.host == "127.0.0.1"
    assert args.port == 8765
    assert args.reload is False


def test_worker_can_process_once() -> None:
    args = build_parser().parse_args(["worker", "--once"])

    assert args.command == "worker"
    assert args.once is True
