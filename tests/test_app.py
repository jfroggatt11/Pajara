"""Application smoke tests."""

from fastapi.testclient import TestClient

from pajara.app import create_app


def test_health_endpoint() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_home_states_product_boundary() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "does not diagnose conditions" in response.text
    assert "advise medication changes" in response.text
