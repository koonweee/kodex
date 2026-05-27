import type { EventEnvelope } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

export type LiveStreamName = "global" | "selected";

export type LiveDiagnosticsSnapshot = {
  cacheInvalidationsByFamily: Record<string, number>;
  duplicateSelectedGlobalDrops: number;
  eventsByStream: Record<LiveStreamName, number>;
  eventsByStreamAndKind: Record<string, number>;
  patchBytesByScope: Record<string, number>;
  reducerBatchCount: number;
  reducerEventCount: number;
  reducerTotalDurationMs: number;
  refreshRequiredCount: number;
  longTaskCount: number;
  longTaskTotalDurationMs: number;
};

const emptySnapshot = (): LiveDiagnosticsSnapshot => ({
  cacheInvalidationsByFamily: {},
  duplicateSelectedGlobalDrops: 0,
  eventsByStream: { global: 0, selected: 0 },
  eventsByStreamAndKind: {},
  patchBytesByScope: {},
  reducerBatchCount: 0,
  reducerEventCount: 0,
  reducerTotalDurationMs: 0,
  refreshRequiredCount: 0,
  longTaskCount: 0,
  longTaskTotalDurationMs: 0,
});

let snapshot = emptySnapshot();

export function recordLiveEvent(stream: LiveStreamName, event: EventEnvelope) {
  if (!liveDiagnosticsEnabled()) {
    return;
  }
  snapshot.eventsByStream[stream] += 1;
  increment(snapshot.eventsByStreamAndKind, `${stream}:${event.kind}`);
  if (event.kind === "thread_view.refresh_required") {
    snapshot.refreshRequiredCount += 1;
  }
  if (event.kind === "thread_view.patch") {
    const scope = stringValue(asRecord(event.payload).scope) ?? "unknown";
    snapshot.patchBytesByScope[scope] = (snapshot.patchBytesByScope[scope] ?? 0) + payloadByteLength(event.payload);
  }
  publishSnapshot();
}

export function recordDuplicateSelectedGlobalDrop() {
  if (!liveDiagnosticsEnabled()) {
    return;
  }
  snapshot.duplicateSelectedGlobalDrops += 1;
  publishSnapshot();
}

export function recordReducerBatch(eventCount: number, durationMs: number) {
  if (!liveDiagnosticsEnabled() || eventCount === 0) {
    return;
  }
  snapshot.reducerBatchCount += 1;
  snapshot.reducerEventCount += eventCount;
  snapshot.reducerTotalDurationMs += durationMs;
  publishSnapshot();
}

export function recordCacheInvalidation(family: string) {
  if (!liveDiagnosticsEnabled()) {
    return;
  }
  increment(snapshot.cacheInvalidationsByFamily, family);
  publishSnapshot();
}

export function installLiveLongTaskObserver(): () => void {
  if (
    !liveDiagnosticsEnabled() ||
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    return () => {};
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      snapshot.longTaskCount += 1;
      snapshot.longTaskTotalDurationMs += entry.duration;
    }
    publishSnapshot();
  });
  observer.observe({ entryTypes: ["longtask"] });
  return () => observer.disconnect();
}

export function getLiveDiagnosticsSnapshot(): LiveDiagnosticsSnapshot {
  return cloneSnapshot(snapshot);
}

export function resetLiveDiagnosticsForTest() {
  snapshot = emptySnapshot();
  publishSnapshot();
}

function liveDiagnosticsEnabled() {
  return import.meta.env.DEV;
}

function increment(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

function payloadByteLength(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return 0;
  }
}

function cloneSnapshot(value: LiveDiagnosticsSnapshot): LiveDiagnosticsSnapshot {
  return {
    cacheInvalidationsByFamily: { ...value.cacheInvalidationsByFamily },
    duplicateSelectedGlobalDrops: value.duplicateSelectedGlobalDrops,
    eventsByStream: { ...value.eventsByStream },
    eventsByStreamAndKind: { ...value.eventsByStreamAndKind },
    patchBytesByScope: { ...value.patchBytesByScope },
    reducerBatchCount: value.reducerBatchCount,
    reducerEventCount: value.reducerEventCount,
    reducerTotalDurationMs: value.reducerTotalDurationMs,
    refreshRequiredCount: value.refreshRequiredCount,
    longTaskCount: value.longTaskCount,
    longTaskTotalDurationMs: value.longTaskTotalDurationMs,
  };
}

function publishSnapshot() {
  if (typeof window === "undefined") {
    return;
  }
  Object.defineProperty(window, "__KODEX_LIVE_DIAGNOSTICS__", {
    configurable: true,
    value: getLiveDiagnosticsSnapshot,
  });
}

declare global {
  interface Window {
    __KODEX_LIVE_DIAGNOSTICS__?: () => LiveDiagnosticsSnapshot;
  }
}
