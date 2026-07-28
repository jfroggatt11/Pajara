.PHONY: check format run test

run:
	uv run pajara

test:
	uv run pytest

format:
	uv run ruff format .
	uv run ruff check --fix .

check:
	uv run ruff format --check .
	uv run ruff check .
	uv run mypy src tests
	uv run pytest

