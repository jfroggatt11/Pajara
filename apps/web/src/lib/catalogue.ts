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
  for (const name of [...existing, ...extracted]) {
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

export interface StructuredIngredientInput {
  name: string;
  amount?: number | null;
  unit?: string | null;
}

export function parseRecipeIngredientLines(raw: string): StructuredIngredientInput[] {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, amountPart, unitPart] = line.split("|").map((part) => part.trim());
      const parsedAmount = amountPart ? Number(amountPart) : Number.NaN;
      return {
        name: namePart,
        ...(!Number.isNaN(parsedAmount) ? {amount: parsedAmount} : {}),
        ...(unitPart ? {unit: unitPart} : {}),
      };
    })
    .filter(({name}) => Boolean(name));
}

export function formatRecipeIngredientLine(
  name: string,
  amount: number | null,
  unit: string | null,
): string {
  if (amount === null && !unit) return name;
  return `${name} | ${amount ?? ""} | ${unit || ""}`.trimEnd();
}

export function mergeRecipeIngredientLines(
  existingText: string,
  extractedIngredients: Array<string | StructuredIngredientInput>,
): string {
  const existing = parseRecipeIngredientLines(existingText);
  const seen = new Set(existing.map(({name}) => name.trim().toLocaleLowerCase()));
  const merged = [...existing];

  for (const extractedIngredient of extractedIngredients) {
    const ingredient =
      typeof extractedIngredient === "string"
        ? {name: extractedIngredient}
        : extractedIngredient;
    const name = ingredient.name.trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push({
      name,
      ...(ingredient.amount === undefined ? {} : {amount: ingredient.amount}),
      ...(ingredient.unit ? {unit: ingredient.unit} : {}),
    });
  }

  return merged
    .map(({name, amount, unit}) =>
      formatRecipeIngredientLine(name, amount ?? null, unit ?? null))
    .join("\n");
}
