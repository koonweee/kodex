import { describe, expect, it } from "vitest";

import type { Automation } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { deleteCachedAutomation, mergeAutomationData, upsertCachedAutomation } from "./cache";

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    consecutiveFailureCount: 0,
    createdAt: "2026-05-07T08:00:00Z",
    id,
    lastError: null,
    lastQueuedInputId: null,
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
});
