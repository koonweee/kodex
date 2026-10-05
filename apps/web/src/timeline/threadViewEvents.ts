import type { EventEnvelope, ThreadSummary, ThreadViewThreadSummary } from "../api/client";

export function threadViewSummaryToThreadSummary(thread: ThreadViewThreadSummary): ThreadSummary {
  return {
    ...thread,
    rawPayload: {},
  };
}

export function threadViewProjectionRevision(event: EventEnvelope): number | null {
  if ((event.kind !== "thread_view.item_delta" && event.kind !== "thread_view.patch") || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const revision = (event.payload as Record<string, unknown>).viewRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : null;
}

export function isCanonicalThreadViewRenderEvent(
  event: EventEnvelope,
  options: { includeGatewayDiagnostics?: boolean } = {},
): boolean {
  if (event.kind === "thread_view.patch" || event.kind === "thread_view.item_delta") {
    return true;
  }
  return options.includeGatewayDiagnostics === true && (event.kind === "gateway.warning" || event.kind === "gateway.error");
}
