import {describe, expect, it} from "vitest";
import type {CaptureReviewField} from "../types";
import {
  isQuickLogFieldConfirmable,
  requiredQuickLogCards,
} from "./ConversationalQuickLog";

function field(field_key: string, proposed_value: unknown): CaptureReviewField {
  return {
    id: field_key,
    capture_session_id: "capture",
    field_key,
    proposed_value,
    confirmed_value: null,
    confirmation_state: "unconfirmed",
    evidence: [],
    provenance: {},
  };
}

describe("conversational Quick Log review", () => {
  it.each([
    ["meal", ["meal_contents", "preparation_contact"]],
    ["drink", ["meal_contents", "preparation_contact"]],
    ["product", ["product_details", "skin_contact"]],
    ["cream", ["product_details", "skin_contact"]],
    ["medication", ["product_details", "skin_contact"]],
    ["exercise", ["activity_products", "skin_contact"]],
    ["shower", ["activity_products", "skin_contact"]],
    ["washing", ["activity_products", "skin_contact"]],
    ["swimming", ["activity_products", "skin_contact"]],
    ["other", ["activity_products", "skin_contact"]],
  ])("uses only core cards for %s", (type, specific) => {
    const cards = requiredQuickLogCards(type);

    expect(cards).toEqual(["date_time", "occurrence_type", "identity", ...specific]);
    expect(cards).toHaveLength(5);
    expect(cards).not.toContain("duration");
    expect(cards).not.toContain("water_temperature");
    expect(cards).not.toContain("quantity");
    expect(cards).not.toContain("dose");
  });

  it("requires a single occurrence choice when evidence contains several", () => {
    expect(requiredQuickLogCards("meal", true)[0]).toBe("occurrence_choice");
    expect(isQuickLogFieldConfirmable(field("occurrence_choice", {
      selected: null,
      choices: ["Lunch", "Dinner"],
    }))).toBe(false);
  });

  it("requires explicit contact and a valid saved identity selection", () => {
    expect(isQuickLogFieldConfirmable(field("identity", {
      name: "Soup",
      mode: "existing",
      selected: null,
    }))).toBe(false);
    expect(isQuickLogFieldConfirmable(field("skin_contact", {
      mode: "unknown",
      items: [],
      body_areas: [],
    }))).toBe(false);
    expect(isQuickLogFieldConfirmable(field("skin_contact", {
      mode: "direct",
      items: ["soap"],
      body_areas: ["both_hands"],
    }))).toBe(true);
  });
});
