FROM ghcr.io/astral-sh/uv:0.9.6 AS uv

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

RUN groupadd --system pajara && useradd --system --gid pajara --home /app pajara

WORKDIR /app
COPY --from=uv /uv /uvx /bin/
COPY services/python/pyproject.toml services/python/uv.lock services/python/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/python/src ./src
RUN uv sync --frozen --no-dev

USER pajara
EXPOSE 8000

CMD ["pajara", "api"]
