import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSynchronizedAnimation } from "./useSynchronizedAnimation";

function Indicator({ state = "running" }: { state?: string }) {
  const ref = useSynchronizedAnimation<HTMLSpanElement>(state);
  return <span ref={ref} data-testid="indicator" />;
}

const original = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
afterEach(() => {
  if (original) Object.defineProperty(Element.prototype, "getAnimations", original);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function animations(...values: Array<{ startTime: number | null; playState: string }>) {
  const read = vi.fn(() => values);
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: read });
  return read;
}

it("aligns newly mounted indicators, including descendant and pseudo animations, to the document epoch", () => {
  const first = { startTime: 120, playState: "running" };
  const read = animations(first);
  render(<Indicator />);
  expect(first.startTime).toBe(0);
  const later = { startTime: null, playState: "running" };
  read.mockReturnValue([later]);
  render(<Indicator />);
  expect(later.startTime).toBe(0);
  expect(read).toHaveBeenCalledWith({ subtree: true });
});

it("realigns replacement animations on state changes and CSS animation starts", () => {
  const current = { startTime: 120, playState: "running" };
  animations(current);
  const view = render(<Indicator />);
  current.startTime = 500;
  view.rerender(<Indicator state="unread" />);
  expect(current.startTime).toBe(0);
  current.startTime = 900;
  act(() => view.getByTestId("indicator").dispatchEvent(new Event("animationstart", { bubbles: true })));
  expect(current.startTime).toBe(0);
});

it("does not restart paused or absent reduced-motion animations", () => {
  const paused = { startTime: null, playState: "paused" };
  const read = animations(paused);
  const view = render(<Indicator />);
  expect(paused.startTime).toBeNull();
  read.mockReturnValue([]);
  view.rerender(<Indicator state="unread" />);
  expect(read).toHaveReturnedWith([]);
});
