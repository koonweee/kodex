import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../api/client";
import {
  getLiveDiagnosticsSnapshot,
  recordCacheInvalidation,
  recordLiveEvent,
  recordReducerBatch,
  resetLiveDiagnosticsForTest,
} from "./liveDiagnostics";

describe("live diagnostics", () => {
  beforeEach(() => {
    delete window.__KODEX_LIVE_DIAGNOSTICS_PAYLOAD_BYTES__;
    resetLiveDiagnosticsForTest();
  });
  afterEach(() => delete window.__KODEX_LIVE_DIAGNOSTICS_PAYLOAD_BYTES__);

  it("keeps stream counters without serializing payloads by default", () => {
    const toJSON = vi.fn(() => ({ scope: "turn", text: "secret prompt text" }));
    recordLiveEvent("global", event({
      kind: "thread_view.patch",
      payload: { scope: "turn", toJSON },
    }));

    expect(toJSON).not.toHaveBeenCalled();
    expect(getLiveDiagnosticsSnapshot()).toMatchObject({
      eventsByStream: { global: 1 },
      eventsByStreamAndKind: { "global:thread_view.patch": 1 },
      patchBytesByScope: {},
    });
  });

  it("counts UTF-8 payload bytes only while explicitly enabled", () => {
    const toJSON = vi.fn(() => ({ scope: "turn", text: "é" }));
    const patch = event({ kind: "thread_view.patch", payload: { scope: "turn", toJSON } });
    window.__KODEX_LIVE_DIAGNOSTICS_PAYLOAD_BYTES__ = true;
    recordLiveEvent("global", patch);
    window.__KODEX_LIVE_DIAGNOSTICS_PAYLOAD_BYTES__ = false;
    recordLiveEvent("global", patch);

    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(getLiveDiagnosticsSnapshot()).toMatchObject({
      eventsByStream: { global: 2 },
      patchBytesByScope: { turn: 28 },
    });
  });

  it("records stream counters and patch bytes without storing payload text", () => {
    window.__KODEX_LIVE_DIAGNOSTICS_PAYLOAD_BYTES__ = true;
    recordLiveEvent("global", event({
      kind: "thread_view.patch",
      payload: {
        scope: "turn",
        threadId: "thread-1",
        affectedTurnIds: ["turn-1"],
        rows: [{ id: "row-1", item: { payload: { item: { text: "secret prompt text" } } } }],
      },
    }));

    const snapshot = getLiveDiagnosticsSnapshot();
    expect(snapshot.eventsByStream.global).toBe(1);
    expect(snapshot.eventsByStreamAndKind["global:thread_view.patch"]).toBe(1);
    expect(snapshot.patchBytesByScope.turn).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("secret prompt text");
  });

  it("records refresh signals, reducer batches, and cache invalidations", () => {
    recordLiveEvent("global", event({ kind: "thread_view.refresh_required" }));
    recordReducerBatch(3, 2.5);
    recordCacheInvalidation("projectThreads");

    expect(getLiveDiagnosticsSnapshot()).toMatchObject({
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
