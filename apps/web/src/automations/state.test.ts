import { describe, expect, it } from "vitest";

import type { Automation, EventEnvelope } from "../api/client";
import { applyAutomationEvent, mergeAutomationSnapshot } from "./state";

const automation: Automation = {
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
};

describe("automation state", () => {
  it("upserts and deletes automations from events", () => {
    const upserted = applyAutomationEvent([], event("automation.item_upsert", automation));
    expect(upserted).toEqual([automation]);

    const replaced = applyAutomationEvent(
      upserted,
      event("automation.item_upsert", { ...automation, name: "Daily report" }),
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0].name).toBe("Daily report");

    const deleted = applyAutomationEvent(replaced, event("automation.item_deleted", { id: automation.id }));
    expect(deleted).toEqual([]);
  });

  it("keeps live changes when a stale snapshot resolves after an event", () => {
    const live = applyAutomationEvent([], event("automation.item_deleted", { id: automation.id }));
    expect(mergeAutomationSnapshot(live, [automation], 0, 1)).toEqual(live);
    expect(mergeAutomationSnapshot(live, [automation], 0, 0)).toEqual([automation]);
  });
});

function event(kind: string, payload: unknown): EventEnvelope {
  return {
    id: `event-${kind}`,
    seq: 1,
    kind,
    projectId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    codexMethod: null,
    payload,
    receivedAt: "2026-05-07T08:00:00Z",
  };
}
