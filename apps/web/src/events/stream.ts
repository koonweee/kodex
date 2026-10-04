import type { EventEnvelope } from "../api/client";

type EventSourceLike = {
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
  onerror: (() => void) | null;
  onopen?: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
};

type EventSourceCtor = new (url: string) => EventSourceLike;

type EventStreamClientOptions = {
  EventSourceCtor?: EventSourceCtor;
  beforeConnect?: () => Promise<boolean>;
  cursor?: number;
  excludeThreadId?: string | null;
  includeGlobal?: boolean;
  reconnectDelayMs?: number;
  threadId?: string;
  threadIds?: string[];
  onEvent: (event: EventEnvelope) => void;
  onStatusChange?: (status: "connected" | "reconnecting" | "closed") => void;
};

const GATEWAY_SSE_EVENT_TYPES = [
  "account.login_completed",
  "account.updated",
  "approval.changed",
  "account.rate_limits_updated",
  "automation.item_deleted",
  "automation.item_upsert",
  "gateway.error",
  "gateway.warning",
  "app_surface.bridge_call",
  "app_surface.model_context_updated",
  "app_surface.presentation_requested",
  "app_surface.session_archived",
  "app_surface.session_error",
  "app_surface.session_submitted",
  "app_surface.session_upserted",
  "mcp.config_changed",
  "mcp.oauth_login_completed",
  "mcp.server_status_updated",
  "skills.changed",
  "thread_view.item_delta",
  "thread_view.patch",
  "thread_view.refresh_required",
  "thread.notifications_updated",
  "thread.pin_updated",
  "thread.read_updated",
  "thread.subagent_started",
  "thread.subagent_stopped",
  "thread.subagent_updated",
  "thread.subagents_changed",
  "thread.upserted",
  "timeline.thread_metadata",
  "turn_queue.item_deleted",
  "turn_queue.item_upsert",
  "workspace.focus_updated",
  "workspace.pane_deleted",
  "workspace.pane_upserted",
  "workspace.updated",
];

export function createEventStreamClient({
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
  beforeConnect,
  cursor,
  excludeThreadId,
  includeGlobal,
  reconnectDelayMs = 1000,
  threadId,
  threadIds,
  onEvent,
  onStatusChange,
}: EventStreamClientOptions) {
  let closed = false;
  let eventSource: EventSourceLike | null = null;
  let lastSeq = cursor;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionAttempt = 0;
  let hasStarted = false;

  function scheduleReconnect() {
    if (closed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect() {
    if (closed || !EventSourceCtor) {
      return;
    }

    const attempt = ++connectionAttempt;
    const isCurrent = () => !closed && connectionAttempt === attempt;
    function openStream() {
      if (!isCurrent() || !EventSourceCtor) return;
      // Snapshot recovery callbacks must also wait until the instance is confirmed.
      if (hasStarted) onStatusChange?.("reconnecting");
      if (!isCurrent()) return;
      eventSource?.close();
      const source = new EventSourceCtor(
        eventStreamUrl({ cursor: lastSeq, excludeThreadId, includeGlobal, threadId, threadIds }),
      );
      eventSource = source;
      hasStarted = true;
      source.onopen = () => {
        if (isCurrent() && eventSource === source) onStatusChange?.("connected");
      };

      const handleMessage = (message: MessageEvent<string>) => {
        if (!isCurrent() || eventSource !== source) return;
        const event = JSON.parse(message.data) as EventEnvelope;
        lastSeq = Math.max(lastSeq ?? 0, event.seq);
        onEvent(event);
      };

      source.onmessage = handleMessage;
      for (const type of GATEWAY_SSE_EVENT_TYPES) {
        source.addEventListener?.(type, handleMessage);
      }

      source.onerror = () => {
        if (!isCurrent() || eventSource !== source) return;
        source.close();
        eventSource = null;
        scheduleReconnect();
      };
    }

    if (!beforeConnect) {
      openStream();
      return;
    }
    void (async () => {
      try {
        const allowed = await beforeConnect();
        if (!isCurrent()) return;
        if (allowed) openStream();
        else scheduleReconnect();
      } catch {
        if (isCurrent()) scheduleReconnect();
      }
    })();
  }

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    eventSource?.close();
    eventSource = null;
    onStatusChange?.("closed");
  }

  return { close, connect };
}

function eventStreamUrl({
  cursor,
  excludeThreadId,
  includeGlobal,
  threadId,
  threadIds,
}: {
  cursor?: number;
  excludeThreadId?: string | null;
  includeGlobal?: boolean;
  threadId?: string;
  threadIds?: string[];
}): string {
  const baseUrl =
    typeof window === "undefined" ? "http://127.0.0.1:8787" : window.location.origin;
  const url = new URL("/v1/events", baseUrl);
  if (typeof cursor === "number") {
    url.searchParams.set("cursor", String(cursor));
  }
  if (typeof includeGlobal === "boolean") {
    url.searchParams.set("includeGlobal", String(includeGlobal));
  }
  const uniqueThreadIds = Array.from(
    new Set((threadIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  if (uniqueThreadIds.length > 0) {
    url.searchParams.set("threadIds", uniqueThreadIds.join(","));
  } else if (threadId) {
    url.searchParams.set("threadId", threadId);
  }
  if (excludeThreadId) {
    url.searchParams.set("excludeThreadId", excludeThreadId);
  }
  return `${url.pathname}${url.search}`;
}
