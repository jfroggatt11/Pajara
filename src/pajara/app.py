"""FastAPI application factory."""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

PACKAGE_ROOT = Path(__file__).parent
templates = Jinja2Templates(directory=PACKAGE_ROOT / "templates")


def create_app() -> FastAPI:
    """Create the Pajara web application."""
    app = FastAPI(
        title="Pajara",
        summary="Local-first dermatitis tracking and hypothesis-generation",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
    )

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def home(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(request=request, name="home.html")

    @app.get("/health", tags=["operations"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
