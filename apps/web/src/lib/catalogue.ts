import type {CatalogueItem} from "../types";

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
