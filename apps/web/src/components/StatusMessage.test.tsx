import {render, screen} from "@testing-library/react";
import {StatusMessage} from "./StatusMessage";

test("renders errors as alerts", () => {
  render(<StatusMessage error="Could not save" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
});

test("renders success as status", () => {
  render(<StatusMessage success="Saved" />);
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
});

