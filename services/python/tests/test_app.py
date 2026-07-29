"""Application operation endpoint tests."""

from fastapi.testclient import TestClient

from pajara.app import create_app
from pajara.config import Settings


def test_health_endpoint_is_available_without_configuration() -> None:
    with TestClient(create_app(Settings())) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_requires_backend_configuration() -> None:
    with TestClient(create_app(Settings())) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["detail"] == "Required backend configuration is missing"


def test_readiness_requires_user_scoped_supabase_key() -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="service-secret",
        supabase_jwt_issuer="https://example.supabase.co/auth/v1",
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/ready")

    assert response.status_code == 503


def test_readiness_accepts_complete_backend_configuration() -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="publishable",
        supabase_service_role_key="service-secret",
        supabase_jwt_issuer="https://example.supabase.co/auth/v1",
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_production_disables_interactive_api_docs() -> None:
    app = create_app(Settings(environment="production"))

    assert app.docs_url is None
