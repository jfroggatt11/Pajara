"""Shared JSON Schema fixture tests."""

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

REPOSITORY = Path(__file__).parents[3]
SCHEMAS = REPOSITORY / "packages" / "schemas" / "v1"
FIXTURES = REPOSITORY / "packages" / "schemas" / "fixtures" / "valid"


def validate(schema_name: str, fixture_name: str) -> None:
    schema = json.loads((SCHEMAS / schema_name).read_text())
    fixture = json.loads((FIXTURES / fixture_name).read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(fixture)


def test_skin_observation_fixture() -> None:
    validate("observation.schema.json", "skin-observation.json")


def test_meal_preparation_fixture() -> None:
    validate("meal-preparation.schema.json", "meal-preparation.json")
