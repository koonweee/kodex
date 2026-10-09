import type {
  EventEnvelope,
  ThreadNotificationSettingsResponse,
  ThreadRead,
} from "../api/client";
import type { ThreadSummary } from "../api/client";
import { asRecord, numberValue, stringValue } from "../shared/values";

type ThreadStatusUpdate = { threadId: string; status: ThreadSummary["status"]; updatedAt: number | null };
export type ThreadUpsert =
  | { scope: "project"; projectId: string; thread: ThreadSummary }
  | { scope: "chat"; thread: ThreadSummary };

export function archivedThreadIdFromEvent(event: EventEnvelope): string | null {
  if (event.kind !== "thread.subagents_changed" || event.codexMethod !== "thread/archived") {
    return null;
  }
  return stringValue(asRecord(event.payload).changedThreadId);
}

export function unarchivedThreadIdFromEvent(event: EventEnvelope): string | null {
  if (event.kind !== "thread.subagents_changed" || event.codexMethod !== "thread/unarchived") {
    return null;
  }
  return stringValue(asRecord(event.payload).changedThreadId);
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

export function threadReadUpdateFromEvent(event: EventEnvelope): ThreadRead | null {
  if (event.kind !== "thread.read_updated") return null;
  const payload = asRecord(event.payload);
  if (typeof payload.threadId !== "string" || typeof payload.updatedAt !== "string" ||
    typeof payload.readRevision !== "number" || typeof payload.readStateKnown !== "boolean" ||
    typeof payload.unreadCompletedAgentTurn !== "boolean" ||
    !(payload.latestCompletedTurnId === null || typeof payload.latestCompletedTurnId === "string") ||
    !(payload.seenCompletedTurnId === null || typeof payload.seenCompletedTurnId === "string")) return null;
  return payload as ThreadRead;
}

export function threadNotificationsUpdateFromEvent(event: EventEnvelope): ThreadNotificationSettingsResponse | null {
  if (event.kind !== "thread.notifications_updated") {
    return null;
  }
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  const notificationsEnabled =
    typeof payload.notificationsEnabled === "boolean"
      ? payload.notificationsEnabled
      : typeof payload.notifications_enabled === "boolean"
        ? payload.notifications_enabled
        : null;
  const updatedAt = stringValue(payload.updatedAt) ?? stringValue(payload.updated_at);
  if (!threadId || notificationsEnabled === null || !updatedAt) {
    return null;
  }
  return {
    threadId,
    notificationsEnabled,
    updatedAt,
  };
}

export function threadStatusUpdateFromEvent(event: EventEnvelope): ThreadStatusUpdate | null {
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }

  if (event.kind === "thread_view.patch") {
    const status =
      normalizeThreadStatus(stringValue(payload.threadStatus) ?? stringValue(payload.thread_status)) ??
      normalizeRuntimeStatus(stringValue(payload.liveState));
    return status
      ? {
          threadId,
          status,
          updatedAt: status === "active" ? null : eventReceivedAtSeconds(event.receivedAt),
        }
      : null;
  }

  return null;
}

function eventReceivedAtSeconds(receivedAt: string): number | null {
  const timestampMs = Date.parse(receivedAt);
  return Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null;
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

function normalizeThreadStatus(status: string | null): ThreadSummary["status"] | null {
  return isThreadStatus(status) ? status : null;
}

function normalizeRuntimeStatus(status: string | null): ThreadSummary["status"] | null {
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
  if (normalized === "notloaded" || normalized === "not_loaded") {
    return "notLoaded";
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
  const readRevision = numberValue(thread.readRevision);
  const unreadCompletedAgentTurn =
    typeof thread.unreadCompletedAgentTurn === "boolean" ? thread.unreadCompletedAgentTurn : null;
  const notificationsEnabled =
    typeof thread.notificationsEnabled === "boolean" ? thread.notificationsEnabled : true;

  if (
    !id ||
    !cwd ||
    !isThreadStatus(status) ||
    createdAt === null ||
    updatedAt === null ||
    readRevision === null ||
    typeof thread.readStateKnown !== "boolean" ||
    unreadCompletedAgentTurn === null ||
    !("rawPayload" in thread)
  ) {
    return null;
  }

  thread.notificationsEnabled = notificationsEnabled;
  return thread as ThreadSummary;
}

function isThreadStatus(status: string | null): status is ThreadSummary["status"] {
  return status === "active" || status === "idle" || status === "notLoaded" || status === "systemError";
}
