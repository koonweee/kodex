import type {
  EventEnvelope,
  ThreadNotificationSettingsResponse,
  ThreadReadStateUpdate,
  ThreadSubagentSummary,
} from "../api/client";
import type { ThreadSummary } from "../api/client";
import { asRecord, numberValue, stringValue } from "../shared/values";

type ThreadStatusUpdate = { threadId: string; status: ThreadSummary["status"]; updatedAt: number | null };
export type ThreadSubagentDiscoveryEvent =
  | { kind: "upsert"; parentThreadId: string; subagent: ThreadSubagentSummary }
  | { kind: "delete"; parentThreadId: string; subagentId: string }
  | { kind: "refresh"; parentThreadId: string };
export type ThreadUpsert =
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

export function threadReadUpdateFromEvent(event: EventEnvelope): ThreadReadStateUpdate | null {
  if (event.kind !== "thread.read_updated") {
    return null;
  }
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  const seenCompletedAgentTurnSeq = numberValue(
    payload.seenCompletedAgentTurnSeq ?? payload.seen_completed_agent_turn_seq,
  );
  const lastCompletedAgentTurnSeq = numberValue(
    payload.lastCompletedAgentTurnSeq ?? payload.last_completed_agent_turn_seq,
  );
  const unreadCompletedAgentTurn =
    typeof payload.unreadCompletedAgentTurn === "boolean"
      ? payload.unreadCompletedAgentTurn
      : typeof payload.unread_completed_agent_turn === "boolean"
        ? payload.unread_completed_agent_turn
        : null;
  if (!threadId || seenCompletedAgentTurnSeq === null || unreadCompletedAgentTurn === null) {
    return null;
  }
  return {
    threadId,
    seenCompletedAgentTurnSeq,
    lastCompletedAgentTurnSeq,
    unreadCompletedAgentTurn,
  };
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

export function threadSubagentDiscoveryEventFromEvent(event: EventEnvelope): ThreadSubagentDiscoveryEvent | null {
  if (
    event.kind !== "thread.subagent_started" &&
    event.kind !== "thread.subagent_updated" &&
    event.kind !== "thread.subagent_stopped" &&
    event.kind !== "thread.subagents_changed"
  ) {
    return null;
  }
  const payload = asRecord(event.payload);
  const parentThreadId = stringValue(payload.parentThreadId) ?? stringValue(payload.parent_thread_id) ?? event.threadId;
  if (!parentThreadId) {
    return null;
  }
  if (event.kind === "thread.subagents_changed") {
    return { kind: "refresh", parentThreadId };
  }
  if (event.kind === "thread.subagent_stopped") {
    const subagentId = stringValue(payload.subagentId) ?? stringValue(payload.subagent_id);
    return subagentId ? { kind: "delete", parentThreadId, subagentId } : { kind: "refresh", parentThreadId };
  }
  const subagent = threadSubagentSummaryFromValue(payload.subagent);
  return subagent ? { kind: "upsert", parentThreadId, subagent } : { kind: "refresh", parentThreadId };
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
  const seenCompletedAgentTurnSeq = numberValue(thread.seenCompletedAgentTurnSeq);
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
    seenCompletedAgentTurnSeq === null ||
    unreadCompletedAgentTurn === null ||
    !("rawPayload" in thread)
  ) {
    return null;
  }

  thread.notificationsEnabled = notificationsEnabled;
  return thread as ThreadSummary;
}

function threadSubagentSummaryFromValue(value: unknown): ThreadSubagentSummary | null {
  const subagent = asRecord(value);
  const id = stringValue(subagent.id);
  const parentThreadId = stringValue(subagent.parentThreadId) ?? stringValue(subagent.parent_thread_id);
  const status = stringValue(subagent.status);
  const liveState = stringValue(subagent.liveState) ?? stringValue(subagent.live_state);
  const updatedAt = numberValue(subagent.updatedAt ?? subagent.updated_at);
  if (!id || !parentThreadId || !isThreadStatus(status) || !isThreadLiveState(liveState) || updatedAt === null) {
    return null;
  }
  return {
    id,
    parentThreadId,
    agentNickname: stringValue(subagent.agentNickname) ?? stringValue(subagent.agent_nickname),
    agentRole: stringValue(subagent.agentRole) ?? stringValue(subagent.agent_role),
    status,
    liveState,
    updatedAt,
  };
}

function isThreadStatus(status: string | null): status is ThreadSummary["status"] {
  return status === "active" || status === "idle" || status === "notLoaded" || status === "systemError";
}

function isThreadLiveState(liveState: string | null): liveState is ThreadSubagentSummary["liveState"] {
  return liveState === "idle" || liveState === "notLoaded" || liveState === "streaming" || liveState === "syncing";
}
