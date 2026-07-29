import type {CatalogueExtraction, CatalogueItem} from "../types";

export function parseIngredientNames(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function sortCatalogueItems(items: CatalogueItem[]): CatalogueItem[] {
  return [...items].sort((left, right) => {
    const favoriteDifference =
      Number(Boolean(right.attributes.favorite))
      - Number(Boolean(left.attributes.favorite));
    const recentDifference =
      String(right.attributes.last_used_at || "")
        .localeCompare(String(left.attributes.last_used_at || ""));
    return favoriteDifference
      || recentDifference
      || left.canonical_name.localeCompare(right.canonical_name);
  });
}

export function mergeIngredientNames(
  existing: string[],
  extracted: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...extracted, ...existing]) {
    const trimmed = name.trim();
    const normalized = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(trimmed);
  }
  return merged;
}

export function catalogueReviewDefaults(
  item: CatalogueItem | undefined,
  proposal: CatalogueExtraction["proposal"],
  existingIngredients: string[],
): {name: string; brand: string; variant: string; ingredients: string} {
  return {
    name: item?.canonical_name.trim() || proposal?.product_name?.trim() || "",
    brand: item?.attributes.brand?.trim() || proposal?.brand?.trim() || "",
    variant: item?.attributes.variant?.trim() || proposal?.variant?.trim() || "",
    ingredients: mergeIngredientNames(
      existingIngredients,
      (proposal?.ingredients || []).map(({name}) => name),
    ).join("\n"),
  };
}

export function isSameSuggestion(current: string, suggested: string | null | undefined): boolean {
  return current.trim().toLocaleLowerCase() === (suggested || "").trim().toLocaleLowerCase();
}
