import { describe, expect, it } from "vitest";

import type { Automation } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import {
  automationRevision,
  applyCachedAutomationEvent,
  deleteCachedAutomation,
  mergeAutomationData,
  reconcileAutomationSnapshot,
  upsertCachedAutomation,
} from "./cache";

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    consecutiveFailureCount: 0,
    createdAt: "2026-05-07T08:00:00Z",
    id,
    lastError: null,
    lastNativeQueueId: null,
    lastRunAt: null,
    name: id,
    nextRunAt: "2026-05-07T09:00:00Z",
    pausedReason: null,
    prompt: "Check status",
    schedule: { repeatEvery: { unit: "minutes", value: 30 }, startAt: "2026-05-07T08:00:00Z" },
    status: "active",
    targetThreadId: "thread-1",
    updatedAt: "2026-05-07T08:00:00Z",
    ...overrides,
  };
}

describe("automation query cache helpers", () => {
  it("preserves live cache rows when a stale snapshot resolves later", () => {
    const live = automation("automation-live", { name: "Live automation" });

    expect(mergeAutomationData([live], [automation("automation-old")])).toEqual([
      live,
      automation("automation-old"),
    ]);
  });

  it("does not resurrect automations deleted after a snapshot started", () => {
    const queryClient = createKodexQueryClient();
    const deleted = automation("automation-deleted");
    upsertCachedAutomation(queryClient, deleted);

    deleteCachedAutomation(queryClient, deleted.id);

    const tombstones = queryClient.getQueryData<string[]>(queryKeys.automationTombstones) ?? [];
    expect(mergeAutomationData(queryClient.getQueryData(queryKeys.automations), [deleted], tombstones)).toEqual([]);
  });

  it("replays cache changes over a snapshot that resolved after live events", () => {
    const queryClient = createKodexQueryClient();
    const loadRevision = automationRevision(queryClient);
    const live = automation("automation-live");
    applyCachedAutomationEvent(queryClient, {
      id: "event-live",
      kind: "automation.item_upsert",
      payload: live,
      receivedAt: "2026-05-07T08:01:00Z",
      seq: 1,
      threadId: null,
    });

    expect(reconcileAutomationSnapshot(queryClient, [automation("automation-snapshot")], loadRevision)).toEqual([
      live,
      automation("automation-snapshot"),
    ]);
  });

  it("treats an unchanged snapshot as authoritative membership", () => {
    const queryClient = createKodexQueryClient();
    upsertCachedAutomation(queryClient, automation("removed-while-disconnected"));
    const loadRevision = automationRevision(queryClient);

    expect(reconcileAutomationSnapshot(queryClient, [], loadRevision)).toEqual([]);
  });

  it("removes missed deletions while replaying a concurrent live upsert", () => {
    const queryClient = createKodexQueryClient();
    upsertCachedAutomation(queryClient, automation("deleted-while-disconnected"));
    const loadRevision = automationRevision(queryClient);
    const live = automation("concurrent-live");
    applyCachedAutomationEvent(queryClient, {
      id: "event-concurrent",
      kind: "automation.item_upsert",
      payload: live,
      receivedAt: "2026-05-07T08:01:00Z",
      seq: 2,
      threadId: null,
    });

    expect(reconcileAutomationSnapshot(queryClient, [], loadRevision)).toEqual([live]);
  });
});
