import type { EventEnvelope } from "../api/client";
import type { ThreadSummary } from "../api/client";
import { asRecord, numberValue, stringValue } from "../shared/values";

type ThreadRuntimeStatus = "active" | "idle";
type ThreadUpsert =
  | { scope: "project"; projectId: string; thread: ThreadSummary }
  | { scope: "chat"; thread: ThreadSummary };

export function threadPinUpdateFromEvent(event: EventEnvelope): { threadId: string; pinnedAt: string | null } | null {
  if (event.kind !== "thread.pin_updated") {
    return null;
  }
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }
  const pinnedAt = stringValue(payload.pinnedAt) ?? stringValue(payload.pinned_at);
  return { threadId, pinnedAt };
}

export function threadUpsertFromEvent(event: EventEnvelope): ThreadUpsert | null {
  if (event.kind !== "thread.upserted") {
    return null;
  }
  const payload = asRecord(event.payload);
  const scope = stringValue(payload.scope);
  const thread = threadSummaryFromValue(payload.thread);
  if (!thread) {
    return null;
  }

  if (scope === "project") {
    const projectId = stringValue(payload.projectId) ?? event.projectId;
    return projectId ? { scope, projectId, thread } : null;
  }

  if (scope === "chat") {
    return { scope, thread };
  }

  return null;
}

export function completedAgentTurnEvent(event: EventEnvelope): { threadId: string; seq: number } | null {
  if (event.kind !== "thread_view.patch") {
    return null;
  }
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  const liveState = normalizeRuntimeStatus(stringValue(payload.liveState));
  const activeTurnId = stringValue(payload.activeTurnId);
  return threadId && liveState === "idle" && !activeTurnId ? { threadId, seq: event.seq } : null;
}

export function threadStatusUpdateFromEvent(event: EventEnvelope): { threadId: string; status: ThreadRuntimeStatus } | null {
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }

  if (event.kind === "thread_view.patch") {
    const status = normalizeRuntimeStatus(stringValue(payload.liveState));
    return status ? { threadId, status } : null;
  }

  return null;
}

export function threadNameUpdateFromEvent(event: EventEnvelope): { threadId: string; name: string | null } | null {
  const method = (event.codexMethod ?? "").toLowerCase();
  if (method !== "thread/name/updated" && method !== "thread/nameupdated" && method !== "thread/name_updated") {
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

function threadSummaryFromValue(value: unknown): ThreadSummary | null {
  const thread = asRecord(value);
  const id = stringValue(thread.id);
  const cwd = stringValue(thread.cwd);
  const status = stringValue(thread.status);
  const createdAt = numberValue(thread.createdAt);
  const updatedAt = numberValue(thread.updatedAt);
  const seenCompletedAgentTurnSeq = numberValue(thread.seenCompletedAgentTurnSeq);
  const unreadCompletedAgentTurn =
    typeof thread.unreadCompletedAgentTurn === "boolean" ? thread.unreadCompletedAgentTurn : null;

  if (
    !id ||
    !cwd ||
    !isThreadStatus(status) ||
    createdAt === null ||
    updatedAt === null ||
    seenCompletedAgentTurnSeq === null ||
    unreadCompletedAgentTurn === null ||
    !("rawPayload" in thread)
  ) {
    return null;
  }

  return thread as ThreadSummary;
}

function isThreadStatus(status: string | null): status is ThreadSummary["status"] {
  return status === "active" || status === "idle" || status === "notLoaded" || status === "systemError";
}
