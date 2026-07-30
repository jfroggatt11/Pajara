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
