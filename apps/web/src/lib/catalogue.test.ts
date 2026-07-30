import {describe, expect, it} from "vitest";
import type {CatalogueItem} from "../types";
import {
  catalogueReviewDefaults,
  formatRecipeIngredientLine,
  mergeIngredientNames,
  mergeRecipeIngredientLines,
  parseIngredientNames,
  parseRecipeIngredientLines,
  sortCatalogueItems,
} from "./catalogue";

function item(
  id: string,
  name: string,
  attributes: CatalogueItem["attributes"],
): CatalogueItem {
  return {
    id,
    user_id: "user",
    concept_type: "product",
    canonical_name: name,
    attributes,
    archived_at: null,
    created_at: "2026-07-29T00:00:00Z",
  };
}

describe("catalogue helpers", () => {
  it("normalizes pasted ingredient separators without inventing values", () => {
    expect(parseIngredientNames("Water, Glycerin\n\nCitric acid; Fragrance")).toEqual([
      "Water",
      "Glycerin",
      "Citric acid",
      "Fragrance",
    ]);
  });

  it("puts favorites and recently used items first", () => {
    const sorted = sortCatalogueItems([
      item("a", "Soap", {}),
      item("b", "Cream", {last_used_at: "2026-07-29T09:00:00Z"}),
      item("c", "Detergent", {favorite: true}),
    ]);

    expect(sorted.map(({id}) => id)).toEqual(["c", "b", "a"]);
  });

  it("preserves trusted manual identity when the image omits it", () => {
    const defaults = catalogueReviewDefaults(
      item("cream", "My cream", {
        brand: "Manually entered brand",
        variant: "Sensitive",
      }),
      {
        product_name: null,
        brand: null,
        variant: null,
        ingredients: [],
      },
      ["Water", "Glycerin"],
    );

    expect(defaults).toEqual({
      name: "My cream",
      brand: "Manually entered brand",
      variant: "Sensitive",
      ingredients: "Water\nGlycerin",
    });
  });

  it("adds extracted ingredients without dropping manual ingredients", () => {
    expect(
      mergeIngredientNames(
        ["Water", "Glycerin"],
        ["Aqua", "GLYCERIN", "Citric acid"],
      ),
    ).toEqual(["Water", "Glycerin", "Aqua", "Citric acid"]);
  });

  it("parses and formats recipe ingredient quantities", () => {
    expect(
      parseRecipeIngredientLines("Pasta | 200 | g\nTomato | 2 | whole\nOlive oil"),
    ).toEqual([
      {name: "Pasta", amount: 200, unit: "g"},
      {name: "Tomato", amount: 2, unit: "whole"},
      {name: "Olive oil"},
    ]);
    expect(formatRecipeIngredientLine("Pasta", 200, "g")).toBe("Pasta | 200 | g");
  });

  it("merges image readings into a recipe without losing entered quantities", () => {
    expect(
      mergeRecipeIngredientLines(
        "Pasta | 200 | g\nTomato | 2 | whole",
        ["Tomato", {name: "Olive oil", amount: 1, unit: "tbsp"}],
      ),
    ).toBe("Pasta | 200 | g\nTomato | 2 | whole\nOlive oil | 1 | tbsp");
  });
});
