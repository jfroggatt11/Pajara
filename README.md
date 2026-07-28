# Pajara

Pajara is a local-first personal dermatitis tracking and hypothesis-generation tool.
It is intended to help one person collect structured observations and explore
uncertain associations. It does not diagnose conditions, establish causes, or advise
medication changes.

The accepted architecture and phased roadmap are in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Current status

Milestone M0.1 provides the application skeleton and quality gates. Domain schemas,
database persistence, capture workflows, AI extraction, and analysis will be added in
later independently testable milestones.

## Prerequisites

- Python 3.13
- [uv](https://docs.astral.sh/uv/)

## Set up and run

```sh
uv sync --all-groups
uv run pajara
```

Then open <http://127.0.0.1:8000>. The server binds to loopback by default.

For development reload:

```sh
uv run pajara --reload
```

## Quality checks

```sh
make check
```

Individual commands are:

```sh
uv run ruff format --check .
uv run ruff check .
uv run mypy src tests
uv run pytest
```

