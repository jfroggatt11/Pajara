.PHONY: build check dev-api dev-web dev-worker install test

install:
	npm install
	cd services/python && uv sync --all-groups

dev-web:
	npm run dev:web

dev-api:
	cd services/python && uv run pajara api --reload

dev-worker:
	cd services/python && uv run pajara worker

test:
	npm run test:web
	cd services/python && uv run pytest

build:
	npm run build:web

check:
	npm run check:web
	npm run test:web
	npm run build:web
	npm run check:db
	cd services/python && .venv/bin/ruff format --check .
	cd services/python && .venv/bin/ruff check .
	cd services/python && .venv/bin/mypy src tests
	cd services/python && .venv/bin/pytest
