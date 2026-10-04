import type { EventEnvelope, ThreadSummary, ThreadViewThreadSummary } from "../api/client";

export function threadViewSummaryToThreadSummary(thread: ThreadViewThreadSummary): ThreadSummary {
  return {
    ...thread,
    rawPayload: {},
  };
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
