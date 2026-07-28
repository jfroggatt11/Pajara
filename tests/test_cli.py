"""Command-line configuration tests."""

from pajara.cli import build_parser


def test_server_defaults_to_loopback() -> None:
    args = build_parser().parse_args([])

    assert args.host == "127.0.0.1"
    assert args.port == 8000
    assert args.reload is False
