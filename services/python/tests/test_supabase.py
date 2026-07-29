"""Supabase API-key and user-token header tests."""

from pajara.supabase import SupabaseClient


def test_new_secret_key_is_not_sent_as_bearer_token() -> None:
    client = SupabaseClient("https://example.supabase.co", "sb_secret_server")

    assert client.headers["apikey"] == "sb_secret_server"
    assert "Authorization" not in client.headers


def test_user_client_sends_publishable_key_and_user_jwt_separately() -> None:
    client = SupabaseClient(
        "https://example.supabase.co",
        "sb_publishable_browser",
        "user.jwt.value",
    )

    assert client.headers["apikey"] == "sb_publishable_browser"
    assert client.headers["Authorization"] == "Bearer user.jwt.value"


def test_legacy_service_role_key_remains_supported() -> None:
    client = SupabaseClient("https://example.supabase.co", "legacy.jwt.value")

    assert client.headers["Authorization"] == "Bearer legacy.jwt.value"
