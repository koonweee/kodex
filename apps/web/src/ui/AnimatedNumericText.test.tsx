import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AnimatedNumericText } from "./AnimatedNumericText";

it("keeps seconds and minutes in their slots when higher duration units appear", () => {
  const label = (text: string) => <MantineProvider><button><AnimatedNumericText text={text} /></button></MantineProvider>;
  const { rerender, container } = render(label("Working for 59s"));
  rerender(label("Working for 1m 00s"));
  expect(screen.getByRole("button")).toHaveAccessibleName("Working for 1m 00s");
  expect(screen.getByText("59").parentElement).toHaveTextContent("0059");
  expect(screen.getByText("1").parentElement).toHaveTextContent(/^1$/);
  fireEvent.animationEnd(screen.getByText("00"));
  rerender(label("Working for 59m 59s"));
  for (const current of container.querySelectorAll(".kodex-animated-number-new")) fireEvent.animationEnd(current);
  rerender(label("Working for 1h 00m 00s"));
  expect(screen.getByRole("button")).toHaveAccessibleName("Working for 1h 00m 00s");
  for (const previous of screen.getAllByText("59")) expect(previous.parentElement).toHaveTextContent("0059");
  expect(screen.getByText("1").parentElement).toHaveTextContent(/^1$/);
});
