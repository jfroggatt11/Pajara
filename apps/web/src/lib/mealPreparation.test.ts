import {describe, expect, it} from "vitest";
import {buildMealPreparationSourceText} from "./mealPreparation";

describe("meal preparation extraction source", () => {
  it("labels method and actual contact separately", () => {
    expect(
      buildMealPreparationSourceText({
        method: "Chopped the tomatoes",
        contact: "Raw tomato touched both hands",
        notes: "Washed the knife afterward",
      }),
    ).toBe(
      "Preparation method: Chopped the tomatoes\n"
        + "Actual skin contact during preparation: Raw tomato touched both hands\n"
        + "Additional notes: Washed the knife afterward",
    );
  });

  it("does not invent missing preparation details", () => {
    expect(
      buildMealPreparationSourceText({method: "", contact: "", notes: ""}),
    ).toBe("");
  });
});
