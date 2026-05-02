import { describe, expect, it } from "vitest";

import {
  isTimelineInitialBottomSettled,
  type TimelineInitialBottomSettleSnapshot,
} from "./TimelineView";

function settledSnapshot(overrides: Partial<TimelineInitialBottomSettleSnapshot> = {}): TimelineInitialBottomSettleSnapshot {
  return {
    distanceFromBottom: 0,
    hasRenderedDomBottom: true,
    hasRenderedVirtualBottom: true,
    scrollHeight: 1200,
    totalSize: 1834,
    ...overrides,
  };
}

describe("timeline initial bottom settling", () => {
  it("waits for both scroll height and virtual total size to stabilize", () => {
    const previous = settledSnapshot({ totalSize: 409 });

    expect(isTimelineInitialBottomSettled(settledSnapshot(), previous)).toBe(false);
    expect(isTimelineInitialBottomSettled(settledSnapshot(), settledSnapshot())).toBe(true);
  });

  it("requires the bottom row to be rendered in both the DOM and virtual window", () => {
    const previous = settledSnapshot();

    expect(isTimelineInitialBottomSettled(settledSnapshot({ hasRenderedDomBottom: false }), previous)).toBe(false);
    expect(isTimelineInitialBottomSettled(settledSnapshot({ hasRenderedVirtualBottom: false }), previous)).toBe(false);
  });
});
