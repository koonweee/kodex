import type { EventEnvelope } from "../api/client";

type EventSourceLike = {
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
};

type EventSourceCtor = new (url: string) => EventSourceLike;

type EventStreamClientOptions = {
  EventSourceCtor?: EventSourceCtor;
  cursor?: number;
  reconnectDelayMs?: number;
  threadId?: string;
  onEvent: (event: EventEnvelope) => void;
  onStatusChange?: (status: "connected" | "reconnecting" | "closed") => void;
};

const GATEWAY_SSE_EVENT_TYPES = [
  "approval.created",
  "approval.resolved",
  "codex.notification",
  "gateway.warning",
  "timeline.item_delta",
  "timeline.item_upsert",
  "timeline.snapshot",
  "timeline.snapshot_required",
  "timeline.thread_metadata",
  "timeline.thread_status",
  "timeline.turn_upsert",
];

export function createEventStreamClient({
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
  cursor = 0,
  reconnectDelayMs = 1000,
  threadId,
  onEvent,
  onStatusChange,
}: EventStreamClientOptions) {
  let closed = false;
  let eventSource: EventSourceLike | null = null;
  let lastSeq = cursor;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed || !EventSourceCtor) {
      return;
    }

    eventSource = new EventSourceCtor(eventStreamUrl(lastSeq, threadId));
    onStatusChange?.("connected");

    const handleMessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as EventEnvelope;
      lastSeq = Math.max(lastSeq, event.seq);
      onEvent(event);
    };

    eventSource.onmessage = handleMessage;
    for (const type of GATEWAY_SSE_EVENT_TYPES) {
      eventSource.addEventListener?.(type, handleMessage);
    }

    eventSource.onerror = () => {
      if (closed) {
        return;
      }
      eventSource?.close();
      onStatusChange?.("reconnecting");
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    };
  }

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    eventSource?.close();
    onStatusChange?.("closed");
  }

  return { close, connect };
}

function eventStreamUrl(cursor: number, threadId?: string): string {
  const baseUrl =
    typeof window === "undefined" ? "http://127.0.0.1:8787" : window.location.origin;
  const url = new URL("/v1/events", baseUrl);
  url.searchParams.set("cursor", String(cursor));
  if (threadId) {
    url.searchParams.set("threadId", threadId);
  }
  return `${url.pathname}${url.search}`;
}
