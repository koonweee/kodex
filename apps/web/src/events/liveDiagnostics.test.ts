import { beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import {
  getLiveDiagnosticsSnapshot,
  recordCacheInvalidation,
  recordDuplicateSelectedGlobalDrop,
  recordLiveEvent,
  recordReducerBatch,
  resetLiveDiagnosticsForTest,
} from "./liveDiagnostics";

describe("live diagnostics", () => {
  beforeEach(() => resetLiveDiagnosticsForTest());

  it("records stream counters and patch bytes without storing payload text", () => {
    recordLiveEvent("selected", event({
      kind: "thread_view.patch",
      payload: {
        scope: "turn",
        threadId: "thread-1",
        affectedTurnIds: ["turn-1"],
        rows: [{ id: "row-1", item: { payload: { item: { text: "secret prompt text" } } } }],
      },
    }));

    const snapshot = getLiveDiagnosticsSnapshot();
    expect(snapshot.eventsByStream.selected).toBe(1);
    expect(snapshot.eventsByStreamAndKind["selected:thread_view.patch"]).toBe(1);
    expect(snapshot.patchBytesByScope.turn).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("secret prompt text");
  });

  it("records duplicate drops, refreshes, reducer batches, and cache invalidations", () => {
    recordDuplicateSelectedGlobalDrop();
    recordLiveEvent("selected", event({ kind: "thread_view.refresh_required" }));
    recordReducerBatch(3, 2.5);
    recordCacheInvalidation("projectThreads");

    expect(getLiveDiagnosticsSnapshot()).toMatchObject({
      duplicateSelectedGlobalDrops: 1,
      refreshRequiredCount: 1,
      reducerBatchCount: 1,
      reducerEventCount: 3,
      reducerTotalDurationMs: 2.5,
      cacheInvalidationsByFamily: { projectThreads: 1 },
    });
  });
});

function event(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: "event-1",
    seq: 1,
    kind: "gateway.warning",
    codexMethod: null,
    projectId: null,
    threadId: "thread-1",
    turnId: null,
    itemId: null,
    payload: {},
    receivedAt: "2026-05-02T00:00:00Z",
    ...overrides,
  };
}
