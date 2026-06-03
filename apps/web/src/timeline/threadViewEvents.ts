import type { EventEnvelope, ThreadSummary, ThreadViewThreadSummary } from "../api/client";

export function threadViewSummaryToThreadSummary(thread: ThreadViewThreadSummary): ThreadSummary {
  return {
    ...thread,
    rawPayload: {},
  };
}

export function isThreadViewQueueEvent(event: EventEnvelope): boolean {
  return event.kind === "turn_queue.item_upsert" || event.kind === "turn_queue.item_deleted";
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
