import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";

import { useTimelineScrollParent } from "./useTimelineScrollParent";

it("waits for an initially hidden pane to have a viewport, then retains its parent while hidden", () => {
  const parent = document.createElement("div");
  let height = 0;
  Object.defineProperty(parent, "clientHeight", { get: () => height });
  const { result, rerender } = renderHook(() => useTimelineScrollParent(parent));
  expect(result.current).toBeNull();
  height = 655;
  rerender();
  expect(result.current).toBe(parent);
  height = 0;
  rerender();
  expect(result.current).toBe(parent);
});

it("requires a fresh viewport measurement after the parent is replaced or detached", () => {
  const first = document.createElement("div");
  let firstHeight = 655;
  Object.defineProperty(first, "clientHeight", { get: () => firstHeight });
  const second = document.createElement("div");
  let secondHeight = 0;
  Object.defineProperty(second, "clientHeight", { get: () => secondHeight });
  const { result, rerender } = renderHook(({ parent }) => useTimelineScrollParent(parent), {
    initialProps: { parent: first as HTMLDivElement | null },
  });
  expect(result.current).toBe(first);
  rerender({ parent: second });
  expect(result.current).toBeNull();
  firstHeight = 0;
  rerender({ parent: first });
  expect(result.current).toBeNull();
  secondHeight = 655;
  rerender({ parent: second });
  expect(result.current).toBe(second);
  rerender({ parent: null });
  expect(result.current).toBeNull();
  secondHeight = 0;
  rerender({ parent: second });
  expect(result.current).toBeNull();
});
