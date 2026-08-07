import {describe, expect, it, vi} from "vitest";
import {localDatetimeToIso, localDatetimeValue} from "./datetime";

describe("activity date and time helpers", () => {
  it("formats a date for a datetime-local input", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    expect(localDatetimeValue(new Date("2026-08-07T09:05:00Z"))).toBe("2026-08-07T09:05");
    vi.restoreAllMocks();
  });

  it("converts a selected local time to an ISO timestamp", () => {
    const selected = "2026-08-07T09:05";
    expect(new Date(localDatetimeToIso(selected)).getTime()).toBe(new Date(selected).getTime());
  });

  it("rejects an empty selection", () => {
    expect(() => localDatetimeToIso("")).toThrow("Choose when this happened.");
  });
});
