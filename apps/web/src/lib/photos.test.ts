import {describe, expect, it} from "vitest";
import {
  groupPhotos,
  photoDateKey,
  photoSeriesKey,
  photoTimestamp,
} from "./photos";

const photos = [
  {
    id: "later-left-palm",
    bodyAreaCode: "left_hand",
    viewCode: "palm",
    capturedAt: "2026-07-30T18:00:00Z",
    createdAt: "2026-07-30T18:01:00Z",
  },
  {
    id: "right-palm",
    bodyAreaCode: "right_hand",
    viewCode: "palm",
    capturedAt: "2026-07-30T08:00:00Z",
    createdAt: "2026-07-30T08:01:00Z",
  },
  {
    id: "earlier-left-palm",
    bodyAreaCode: "left_hand",
    viewCode: "palm",
    capturedAt: "2026-07-29T08:00:00Z",
    createdAt: "2026-07-29T08:01:00Z",
  },
];

describe("photo grouping", () => {
  it("keeps laterality and view together in a longitudinal series", () => {
    const grouped = groupPhotos(photos, photoSeriesKey);

    expect(grouped["left_hand::palm"].map(({id}) => id)).toEqual([
      "earlier-left-palm",
      "later-left-palm",
    ]);
    expect(grouped["right_hand::palm"].map(({id}) => id)).toEqual([
      "right-palm",
    ]);
  });

  it("groups photos by local calendar date and falls back to creation time", () => {
    expect(photoDateKey(photos[0], "Europe/Rome")).toBe("2026-07-30");
    expect(
      photoDateKey(
        {...photos[0], capturedAt: "2026-07-30T22:30:00Z"},
        "Europe/Rome",
      ),
    ).toBe("2026-07-31");
    expect(
      photoTimestamp({...photos[0], capturedAt: null}),
    ).toBe("2026-07-30T18:01:00Z");
  });
});
