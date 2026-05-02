import type { EventEnvelope } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

export function completedAgentTurnEvent(event: EventEnvelope): { threadId: string; seq: number } | null {
  if (event.codexMethod !== "turn/completed") {
    return null;
  }
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  return threadId ? { threadId, seq: event.seq } : null;
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
