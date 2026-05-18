import { describe, expect, it } from "vitest";

import { timelineFollowOutputBehavior } from "./TimelineView";

describe("timeline virtuoso follow output", () => {
  it("follows live output only when the user is already near the bottom", () => {
    expect(timelineFollowOutputBehavior(true)).toBe("auto");
    expect(timelineFollowOutputBehavior(false)).toBe(false);
  });
});
