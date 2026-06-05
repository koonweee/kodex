import { describe, expect, it } from "vitest";

import { shouldSyncComposerCursorOnKeyUp } from "./keyEvents";

describe("composer key events", () => {
  it("syncs cursor-only keyups without reparsing printable input keyups", () => {
    expect(shouldSyncComposerCursorOnKeyUp("ArrowLeft")).toBe(true);
    expect(shouldSyncComposerCursorOnKeyUp("Home")).toBe(true);
    expect(shouldSyncComposerCursorOnKeyUp("a")).toBe(false);
    expect(shouldSyncComposerCursorOnKeyUp("Backspace")).toBe(false);
    expect(shouldSyncComposerCursorOnKeyUp("Escape")).toBe(false);
  });
});
