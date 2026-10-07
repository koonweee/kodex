import { describe, expect, it } from "vitest";
import { composerSettingsPresentation, shouldExpandComposerOnTouch } from "./presentationPolicy";

describe("composer expansion initiation", () => {
  it.each(["mouse", "pen", "", "touch"])("only expands narrow workspaces for touch, event=%s", (pointerType) => {
    expect(shouldExpandComposerOnTouch(false, pointerType)).toBe(false);
    expect(shouldExpandComposerOnTouch(true, pointerType)).toBe(pointerType === "touch");
  });
});

describe("composer settings overlay presentation", () => {
  it.each([false, true])("retains an anchored menu in a spacious viewport, coarse=%s", (coarse) => {
    expect(composerSettingsPresentation(false, coarse)).toBe("anchored");
  });
  it("requires both compact viewport fit and coarse capability for a sheet", () => {
    expect(composerSettingsPresentation(true, false)).toBe("anchored");
    expect(composerSettingsPresentation(true, true)).toBe("sheet");
  });
});
