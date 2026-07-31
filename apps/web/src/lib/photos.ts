export const photoViews = [
  ["overview", "Overview"],
  ["palm", "Palm / front"],
  ["back", "Back of hand"],
  ["side", "Side"],
  ["close_up", "Close-up"],
  ["other", "Other"],
] as const;

export interface GroupablePhoto {
  id: string;
  bodyAreaCode: string | null;
  viewCode: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export function photoTimestamp(photo: GroupablePhoto): string {
  return photo.capturedAt || photo.createdAt;
}

export function photoSeriesKey(photo: GroupablePhoto): string {
  return `${photo.bodyAreaCode || "unassigned"}::${photo.viewCode || "unspecified"}`;
}

export function photoDateKey(photo: GroupablePhoto, timeZone?: string): string {
  const date = new Date(photoTimestamp(photo));
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}

export function groupPhotos<T extends GroupablePhoto>(
  photos: T[],
  keyFor: (photo: T) => string,
): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const photo of photos) {
    const key = keyFor(photo);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(photo);
  }
  for (const group of Object.values(grouped)) {
    group.sort(
      (left, right) =>
        new Date(photoTimestamp(left)).getTime()
        - new Date(photoTimestamp(right)).getTime(),
    );
  }
  return grouped;
}

export function photoViewLabel(viewCode: string | null): string {
  return photoViews.find(([value]) => value === viewCode)?.[1]
    || viewCode?.replaceAll("_", " ")
    || "Unspecified view";
}
