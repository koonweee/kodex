import { describe, expect, it } from "vitest";

import {
  getDistanceFromBottom,
  getScrollElementBottomTop,
  isTimelineNearBottom,
  timelineFollowOutputBehavior,
} from "./scrollPolicy";

describe("timeline virtuoso follow output", () => {
  it("follows live output only when the user is already near the bottom", () => {
    expect(timelineFollowOutputBehavior(true)).toBe("auto");
    expect(timelineFollowOutputBehavior(false)).toBe(false);
  });
});

describe("timeline scroll policy", () => {
  it("measures distance from the real scroll parent bottom", () => {
    expect(getDistanceFromBottom({ clientHeight: 400, scrollHeight: 3_600, scrollTop: 3_180 })).toBe(20);
  });

  it("treats small residual bottom room as pinned follow mode", () => {
    expect(isTimelineNearBottom({ clientHeight: 400, scrollHeight: 3_600, scrollTop: 3_180 })).toBe(true);
    expect(isTimelineNearBottom({ clientHeight: 400, scrollHeight: 3_600, scrollTop: 3_140 })).toBe(false);
  });

  it("uses the scroll parent's actual maximum scroll top", () => {
    expect(getScrollElementBottomTop({ clientHeight: 400, scrollHeight: 3_620 })).toBe(3_220);
    expect(getScrollElementBottomTop({ clientHeight: 400, scrollHeight: 320 })).toBe(0);
  });
});
