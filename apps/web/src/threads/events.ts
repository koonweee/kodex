import type { EventEnvelope } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

type ThreadRuntimeStatus = "active" | "idle";

export function completedAgentTurnEvent(event: EventEnvelope): { threadId: string; seq: number } | null {
  if (event.kind !== "timeline.turn_upsert") {
    return null;
  }

  const turnPayload = asRecord(asRecord(event.payload).turn);
  const status = stringValue(turnPayload.status)?.toLowerCase();
  if (!status || !["completed", "failed", "cancelled", "canceled", "interrupted"].includes(status)) {
    return null;
  }

  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  return threadId ? { threadId, seq: event.seq } : null;
}

export function threadStatusUpdateFromEvent(event: EventEnvelope): { threadId: string; status: ThreadRuntimeStatus } | null {
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }

  if (event.kind === "timeline.thread_status") {
    const status = normalizeRuntimeStatus(stringValue(payload.status) ?? stringValue(payload.liveState));
    return status ? { threadId, status } : null;
  }

  if (event.kind === "timeline.turn_upsert") {
    const turnPayload = asRecord(payload.turn);
    const status = normalizeRuntimeStatus(stringValue(turnPayload.status));
    return status ? { threadId, status } : null;
  }

  return null;
}

export function threadNameUpdateFromEvent(event: EventEnvelope): { threadId: string; name: string | null } | null {
  const method = (event.codexMethod ?? "").toLowerCase();
  if (method !== "thread/nameupdated" && method !== "thread/name_updated") {
    return null;
  }

  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }

  return {
    threadId,
    name: stringValue(payload.threadName) ?? stringValue(payload.thread_name),
  };
}

function normalizeRuntimeStatus(status: string | null): ThreadRuntimeStatus | null {
  const normalized = status?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["active", "running", "streaming", "inprogress", "in_progress", "pending"].includes(normalized)) {
    return "active";
  }
  if (["idle", "completed", "complete", "failed", "cancelled", "canceled", "interrupted"].includes(normalized)) {
    return "idle";
  }
  return null;
}
