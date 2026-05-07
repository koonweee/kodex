import { describe, expect, it } from "vitest";

import { displayRepeatEvery, formatAutomationInterval } from "./schedule";
import { threadLabelById } from "./threadOptions";
import type { Automation } from "../api/client";

const automation = {
  id: "automation-1",
  name: "Daily status",
  prompt: "Summarize current repo state.",
  targetThreadId: "thread-1",
  schedule: {
    startAt: "2026-05-07T09:00:00Z",
    repeatEvery: { value: 30, unit: "seconds" },
  },
  nextRunAt: "2026-05-07T09:30:00Z",
  status: "active",
  pausedReason: null,
  lastRunAt: null,
  lastQueuedInputId: null,
  lastError: null,
  consecutiveFailureCount: 0,
  createdAt: "2026-05-07T08:00:00Z",
  updatedAt: "2026-05-07T08:00:00Z",
} satisfies Automation;

describe("automation schedule helpers", () => {
  it("shows canonical seconds as the largest clean editing unit", () => {
    expect(displayRepeatEvery({ value: 7200, unit: "seconds" })).toEqual({ repeatValue: 2, repeatUnit: "hours" });
    expect(displayRepeatEvery({ value: 1800, unit: "seconds" })).toEqual({ repeatValue: 30, repeatUnit: "minutes" });
    expect(displayRepeatEvery({ value: 45, unit: "seconds" })).toEqual({ repeatValue: 45, repeatUnit: "seconds" });
  });

  it("formats canonical seconds using readable units in table rows", () => {
    expect(formatAutomationInterval({ ...automation, schedule: { ...automation.schedule, repeatEvery: { value: 7200, unit: "seconds" } } })).toBe("2 hours");
    expect(formatAutomationInterval({ ...automation, schedule: { ...automation.schedule, repeatEvery: { value: 1800, unit: "seconds" } } })).toBe("30 minutes");
    expect(formatAutomationInterval(automation)).toBe("30 seconds");
  });

  it("does not expose raw thread ids when a target thread is unavailable", () => {
    expect(threadLabelById([], "019dfba5-ef44-78c3-8056-1edb7b20e13a")).toBe("Unknown thread");
  });
});
