import { describe, expect, it } from "vitest";

import type { QueuedInput } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { deleteCachedQueuedInput, mergeQueuedInputData, upsertCachedQueuedInput } from "./cache";

function queuedInput(id: string, overrides: Partial<QueuedInput> = {}): QueuedInput {
  return {
    attemptCount: 0,
    createdAt: "2026-05-05T00:00:00Z",
    id,
    input: [{ type: "text", text: id }],
    lastError: null,
    options: {},
    priority: "normal",
    status: "queued",
    threadId: "thread-1",
    updatedAt: "2026-05-05T00:00:00Z",
    ...overrides,
  };
}

describe("queued input query cache helpers", () => {
  it("preserves newer live rows when a stale selected-thread snapshot resolves later", () => {
    const live = queuedInput("queue-newer", {
      input: [{ type: "text", text: "Newer from SSE" }],
      updatedAt: "2026-05-05T00:00:04Z",
    });

    expect(
      mergeQueuedInputData([live], [
        queuedInput("queue-newer", {
          input: [{ type: "text", text: "Stale snapshot" }],
          updatedAt: "2026-05-05T00:00:01Z",
        }),
      ]),
    ).toEqual([live]);
  });

  it("does not resurrect rows deleted after a queued-input snapshot started", () => {
    const queryClient = createKodexQueryClient();
    const deleted = queuedInput("queue-deleted", { input: [{ type: "text", text: "Deleted by SSE" }] });
    const live = queuedInput("queue-newer", {
      input: [{ type: "text", text: "Newer from SSE" }],
      updatedAt: "2026-05-05T00:00:04Z",
    });
    upsertCachedQueuedInput(queryClient, deleted);
    deleteCachedQueuedInput(queryClient, deleted.threadId, deleted.id);
    upsertCachedQueuedInput(queryClient, live);

    const tombstones = queryClient.getQueryData<string[]>(queryKeys.queuedInputTombstones("thread-1")) ?? [];

    expect(
      mergeQueuedInputData(queryClient.getQueryData(queryKeys.queuedInputs("thread-1")), [deleted], tombstones),
    ).toEqual([live]);
  });
});
