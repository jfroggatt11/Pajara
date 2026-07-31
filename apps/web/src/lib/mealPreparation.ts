export function buildMealPreparationSourceText({
  method,
  contact,
  notes,
}: {
  method: string;
  contact: string;
  notes: string;
}): string {
  return [
    method.trim() ? `Preparation method: ${method.trim()}` : "",
    contact.trim() ? `Actual skin contact during preparation: ${contact.trim()}` : "",
    notes.trim() ? `Additional notes: ${notes.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function suggestRecipeName(sourceText: string): string {
  const firstClause = sourceText
    .split(/\r?\n/, 1)[0]
    .split(/[,.]/, 1)[0]
    .trim()
    .replace(/^(made|ate|had|cooked|prepared)\s+/i, "");
  if (!firstClause) return "";
  return firstClause.slice(0, 80).trim();
}
