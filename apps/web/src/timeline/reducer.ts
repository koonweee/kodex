import type { EventEnvelope } from "../api/client";

export type TimelineItem = {
  id: string;
  kind: string;
  status: "started" | "completed";
  text: string;
  payload: unknown;
};

export type TimelineState = {
  activeTurnId: string | null;
  items: TimelineItem[];
  lastSeq: number;
};

export function createTimelineState(): TimelineState {
  return {
    activeTurnId: null,
    items: [],
    lastSeq: 0,
  };
}

export function applyTimelineEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const next: TimelineState = {
    activeTurnId: event.turnId ?? state.activeTurnId,
    items: [...state.items],
    lastSeq: Math.max(state.lastSeq, event.seq),
  };

  if (event.codexMethod === "turn/completed") {
    next.activeTurnId = null;
    return next;
  }

  if (!event.itemId) {
    return next;
  }

  const existingIndex = next.items.findIndex((item) => item.id === event.itemId);
  const existing =
    existingIndex >= 0
      ? next.items[existingIndex]
      : {
          id: event.itemId,
          kind: inferItemKind(event),
          status: "started" as const,
          text: "",
          payload: event.payload,
        };

  const updated = reduceItem(existing, event);

  if (existingIndex >= 0) {
    next.items[existingIndex] = updated;
  } else {
    next.items.push(updated);
  }

  return next;
}

function reduceItem(item: TimelineItem, event: EventEnvelope): TimelineItem {
  if (event.codexMethod?.endsWith("/delta")) {
    return {
      ...item,
      text: item.text + payloadText(event.payload),
      payload: event.payload,
    };
  }

  if (event.codexMethod === "item/completed") {
    return {
      ...item,
      status: "completed",
      text: payloadText(event.payload) || item.text,
      payload: event.payload,
    };
  }

  return {
    ...item,
    kind: inferItemKind(event),
    payload: event.payload,
  };
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyTimelineEvent, createTimelineState());
}

function payloadText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  for (const key of ["delta", "text", "message", "content"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

function inferItemKind(event: EventEnvelope): string {
  const method = event.codexMethod ?? "";
  const payloadType = payloadString(event.payload, "type");
  const payloadKind = payloadString(event.payload, "kind");
  const source = `${method} ${payloadType} ${payloadKind}`.toLowerCase();

  if (event.kind.toLowerCase().includes("warning") || source.includes("warning")) {
    return "warning";
  }
  if (event.kind.toLowerCase().includes("error") || source.includes("error")) {
    return "error";
  }
  if (source.includes("agentmessage") || source.includes("agent_message")) {
    return "agent_message";
  }
  if (source.includes("usermessage") || source.includes("user_message")) {
    return "user_message";
  }
  if (source.includes("reasoning")) {
    return "reasoning";
  }
  if (source.includes("plan")) {
    return "plan";
  }
  if (source.includes("command")) {
    return "command_execution";
  }
  if (source.includes("filechange") || source.includes("file_change")) {
    return "file_change";
  }
  if (source.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (source.includes("dynamic")) {
    return "dynamic_tool_call";
  }
  return method || event.kind;
}

function payloadString(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
