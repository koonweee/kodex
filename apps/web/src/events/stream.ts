import type { EventEnvelope, ThreadDeliveryOptions } from "../api/client";

type EventSourceLike = {
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
  onerror: (() => void) | null;
  onopen?: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
};

type EventSourceCtor = new (url: string) => EventSourceLike;

type EventStreamClientOptions = ThreadDeliveryOptions & {
  EventSourceCtor?: EventSourceCtor;
  beforeConnect?: () => Promise<boolean>;
  cursor?: number;
  excludeThreadId?: string | null;
  includeGlobal?: boolean;
  reconnectDelayMs?: number;
  threadId?: string;
  threadIds?: string[];
  onEvent: (event: EventEnvelope) => void;
  onStatusChange?: (status: "connected" | "reconnecting" | "closed", reason?: "delivery_options") => void;
};

const GATEWAY_SSE_EVENT_TYPES = [
  "account.login_completed",
  "account.updated",
  "approval.changed",
  "project.changed",
  "thread.project_updated",
  "thread.settings_updated",
  "thread.summary_changed",
  "thread.goal_changed",
  "account.rate_limits_updated",
  "automation.item_deleted",
  "automation.item_upsert",
  "automation.run_updated",
  "frontend.updated",
  "gateway.error",
  "gateway.warning",
  "app_surface.bridge_call",
  "app_surface.model_context_updated",
  "app_surface.presentation_requested",
  "app_surface.session_archived",
  "app_surface.session_upserted",
  "config.changed",
  "mcp.oauth_login_completed",
  "mcp.server_status_updated",
  "skills.changed",
  "thread_view.item_delta",
  "thread_view.patch",
  "thread_view.refresh_required",
  "thread.notifications_updated",
  "thread.pins_updated",
  "thread.read_updated",
  "thread.subagents_changed",
  "thread.upserted",
  "timeline.thread_metadata",
  "turn_queue.changed",
  "turn_queue.transfer_changed",
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
  includeDebugEvents = false,
  includeCommandOutputs = false,
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
  let hasConnected = false;
  let recoveryPending = false;
  let deliveryOptions = { includeDebugEvents, includeCommandOutputs };

  function scheduleReconnect() {
    if (closed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect(reason?: "delivery_options") {
    if (closed || !EventSourceCtor) {
      return;
    }

    const attempt = ++connectionAttempt;
    const isCurrent = () => !closed && connectionAttempt === attempt;
    function openStream() {
      if (!isCurrent() || !EventSourceCtor) return;
      // Snapshot recovery callbacks must also wait until the instance is confirmed.
      if (hasStarted && reason !== "delivery_options") onStatusChange?.("reconnecting");
      if (!isCurrent()) return;
      eventSource?.close();
      const source = new EventSourceCtor(
        eventStreamUrl({ cursor: lastSeq, excludeThreadId, includeGlobal, threadId, threadIds, ...deliveryOptions }),
      );
      eventSource = source;
      hasStarted = true;
      source.onopen = () => {
        if (!isCurrent() || eventSource !== source) return;
        const deliveryOnly = reason === "delivery_options" && hasConnected && lastSeq !== undefined && !recoveryPending;
        recoveryPending = false;
        hasConnected = true;
        if (deliveryOnly) onStatusChange?.("connected", "delivery_options");
        else onStatusChange?.("connected");
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
        recoveryPending = true;
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

  function updateDeliveryOptions(next: ThreadDeliveryOptions) {
    const normalized = { includeDebugEvents: next.includeDebugEvents ?? false, includeCommandOutputs: next.includeCommandOutputs ?? false };
    if (closed || (normalized.includeDebugEvents === deliveryOptions.includeDebugEvents && normalized.includeCommandOutputs === deliveryOptions.includeCommandOutputs)) return;
    deliveryOptions = normalized;
    if (!hasStarted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    eventSource?.close();
    eventSource = null;
    connect(recoveryPending ? undefined : "delivery_options");
  }

  return { close, connect, updateDeliveryOptions };
}

function eventStreamUrl({
  cursor,
  excludeThreadId,
  includeGlobal,
  includeDebugEvents,
  includeCommandOutputs,
  threadId,
  threadIds,
}: {
  cursor?: number;
  excludeThreadId?: string | null;
  includeGlobal?: boolean;
  includeDebugEvents?: boolean;
  includeCommandOutputs?: boolean;
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
  if (includeDebugEvents) url.searchParams.set("includeDebugEvents", "true");
  if (includeCommandOutputs) url.searchParams.set("includeCommandOutputs", "true");
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
