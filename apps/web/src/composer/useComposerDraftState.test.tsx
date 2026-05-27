import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useComposerDraftState } from "./useComposerDraftState";

describe("useComposerDraftState", () => {
  it("does not re-render when a repeated text update keeps the same draft state", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useComposerDraftState(0, "draft:test");
    });

    act(() => result.current.updateComposerText("hello", 5));
    const rendersAfterInitialText = renders;

    act(() => result.current.updateComposerText("hello", 5));

    expect(renders).toBe(rendersAfterInitialText);
  });

  it("still updates skill token state when the cursor changes without text changes", () => {
    const { result } = renderHook(() => useComposerDraftState(0, "draft:test"));

    act(() => result.current.updateComposerText("$plan", 5));
    expect(result.current.skillToken).toEqual({ start: 0, end: 5, query: "plan" });

    act(() => result.current.updateComposerText("$plan", 2));
    expect(result.current.skillToken).toEqual({ start: 0, end: 5, query: "p" });
  });
});
