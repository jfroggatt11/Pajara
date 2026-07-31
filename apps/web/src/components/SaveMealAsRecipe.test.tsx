import {render, screen} from "@testing-library/react";
import {SaveMealAsRecipe} from "./SaveMealAsRecipe";

test("prefills preparation details but leaves consumed ingredients for review", () => {
  render(
    <SaveMealAsRecipe
      mealEventId="meal-one"
      defaultName="Tomato pasta"
      defaultMethod="Chopped tomatoes and simmered the sauce"
      defaultContact="Raw tomato touched both hands"
      initiallyOpen
    />,
  );

  expect(screen.getByLabelText("Recipe name")).toHaveValue("Tomato pasta");
  expect(screen.getByLabelText("Preparation method")).toHaveValue(
    "Chopped tomatoes and simmered the sauce",
  );
  expect(screen.getByLabelText("Usual skin contact while preparing")).toHaveValue(
    "Raw tomato touched both hands",
  );
  expect(screen.getByLabelText("Ingredients")).toHaveValue("");
  expect(
    screen.getByText("Ingredients are not inferred from preparation-contact notes."),
  ).toBeInTheDocument();
});
