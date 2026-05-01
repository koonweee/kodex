import type { EventEnvelope } from "../api/client";

export type TimelineStatus = "running" | "completed" | "failed" | "waiting" | "cancelled" | "approval_required";

export type WebSearchAction =
  | { kind: "search"; query: string }
  | { kind: "open"; title?: string; url?: string }
  | { kind: "other"; label: string };

export type TimelineItem = {
  id: string;
  kind: string;
  status: TimelineStatus;
  text: string;
  turnId: string | null;
  seq: number;
  payload: unknown;
  debugEvents: EventEnvelope[];
  action?: string;
  actions?: WebSearchAction[];
  argsSummary?: string;
  command?: string;
  cwd?: string;
  output?: string;
  path?: string;
  resultSummary?: string;
  summary?: string;
  toolName?: string;
};

export type TimelineTurn = {
  turnId: string;
  itemIds: string[];
};

export type TimelineState = {
  activeTurnId: string | null;
  items: TimelineItem[];
  hiddenItems: TimelineItem[];
  turns: TimelineTurn[];
  lastSeq: number;
};

export function createTimelineState(): TimelineState {
  return {
    activeTurnId: null,
    items: [],
    hiddenItems: [],
    turns: [],
    lastSeq: 0,
  };
}

export function applyTimelineEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const next: TimelineState = {
    activeTurnId: event.turnId ?? state.activeTurnId,
    items: [...state.items],
    hiddenItems: [...state.hiddenItems],
    turns: state.turns.map((turn) => ({ ...turn, itemIds: [...turn.itemIds] })),
    lastSeq: Math.max(state.lastSeq, event.seq),
  };

  if (event.codexMethod === "turn/completed") {
    next.activeTurnId = null;
    addHiddenDebugItem(next, event);
    return next;
  }

  if (isLifecycleEvent(event)) {
    if (isWarningEvent(event) || isErrorEvent(event)) {
      addOrReplaceItem(next, createDiagnosticItem(event));
    } else {
      addHiddenDebugItem(next, event);
    }
    return next;
  }

  const presentation = createPresentationItem(event);
  if (!presentation) {
    addHiddenDebugItem(next, event);
    return next;
  }

  if (presentation.hidden) {
    addHiddenDebugItem(next, event, presentation.text);
    return next;
  }

  const existingIndex = next.items.findIndex((item) => item.id === presentation.item.id);
  if (existingIndex >= 0) {
    const existing = next.items[existingIndex];
    next.items[existingIndex] = mergeTimelineItem(existing, presentation.item, event);
  } else {
    next.items.push(presentation.item);
    addToTurn(next, presentation.item);
  }

  return next;
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyTimelineEvent, createTimelineState());
}

function createPresentationItem(event: EventEnvelope): { item: TimelineItem; hidden?: boolean; text?: string } | null {
  const item = eventItem(event);
  const itemType = normalizedItemType(event);
  const text = payloadText(event.payload);
  const status = eventStatus(event);
  const id = presentationItemId(event, itemType);
  const base = createBaseItem(event, id, itemType, status);

  if (itemType === "assistant_message") {
    return {
      item: {
        ...base,
        text,
      },
      hidden: !text,
      text: "Empty assistant message",
    };
  }

  if (itemType === "user_message") {
    return {
      item: {
        ...base,
        text,
      },
      hidden: !text,
      text: "Empty user message",
    };
  }

  if (itemType === "reasoning_summary") {
    const summary = reasoningSummary(event.payload);
    return {
      item: {
        ...base,
        summary,
        text: summary,
      },
      hidden: !summary,
      text: "Empty reasoning",
    };
  }

  if (itemType === "web_search_group") {
    const action = webSearchAction(event.payload);
    return {
      item: {
        ...base,
        actions: action ? [action] : [],
        text: actionLabel(action),
      },
      hidden: !action,
      text: "Unsupported web search action",
    };
  }

  if (itemType === "command_execution") {
    const command = stringValue(item.command) || stringValue(payloadRecord(event.payload)?.command);
    const cwd = stringValue(item.cwd) || stringValue(payloadRecord(event.payload)?.cwd);
    const output =
      stringValue(item.output) ||
      stringValue(item.stdout) ||
      stringValue(item.stderr) ||
      stringValue(payloadRecord(event.payload)?.output);
    return {
      item: {
        ...base,
        command,
        cwd,
        output,
        text: command || text,
      },
      hidden: !command && !text,
      text: "Empty command execution",
    };
  }

  if (itemType === "file_change") {
    const path = stringValue(item.path) || stringValue(payloadRecord(event.payload)?.path);
    const action = stringValue(item.action) || stringValue(item.change) || stringValue(payloadRecord(event.payload)?.action);
    return {
      item: {
        ...base,
        action,
        path,
        text: [action, path].filter(Boolean).join(" "),
      },
      hidden: !path && !action,
      text: "Empty file change",
    };
  }

  if (itemType === "mcp_tool_call" || itemType === "dynamic_tool_call") {
    const toolName =
      stringValue(item.toolName) ||
      stringValue(item.name) ||
      stringValue(item.tool) ||
      stringValue(payloadRecord(event.payload)?.toolName) ||
      stringValue(payloadRecord(event.payload)?.name);
    const args = item.arguments ?? item.args ?? payloadRecord(event.payload)?.arguments ?? payloadRecord(event.payload)?.args;
    const result = item.result ?? item.output ?? payloadRecord(event.payload)?.result ?? payloadRecord(event.payload)?.output;
    return {
      item: {
        ...base,
        argsSummary: summarizeValue(args),
        resultSummary: summarizeValue(result),
        text: toolName || text,
        toolName,
      },
      hidden: !toolName && !text,
      text: "Empty tool call",
    };
  }

  if (itemType === "warning" || itemType === "error") {
    return { item: createDiagnosticItem(event) };
  }

  if (event.itemId) {
    return {
      item: {
        ...base,
        kind: "debug_event",
        text: text || "Unsupported item",
      },
    };
  }

  return null;
}

function createBaseItem(event: EventEnvelope, id: string, kind: string, status: TimelineStatus): TimelineItem {
  return {
    id,
    kind,
    status,
    text: "",
    turnId: event.turnId ?? null,
    seq: event.seq,
    payload: event.payload,
    debugEvents: [event],
  };
}

function createDiagnosticItem(event: EventEnvelope): TimelineItem {
  return {
    ...createBaseItem(event, event.itemId ?? `diagnostic-${event.id}`, isErrorEvent(event) ? "error" : "warning", eventStatus(event)),
    text: payloadText(event.payload) || (isErrorEvent(event) ? "Error" : "Warning"),
  };
}

function mergeTimelineItem(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  const text = event.codexMethod?.endsWith("/delta")
    ? existing.text + incoming.text
    : incoming.text || existing.text;
  return {
    ...existing,
    ...incoming,
    actions: mergeActions(existing.actions, incoming.actions),
    debugEvents: [...existing.debugEvents, event],
    kind: incoming.kind === "debug_event" && existing.kind !== "debug_event" ? existing.kind : incoming.kind,
    payload: event.payload,
    seq: Math.min(existing.seq, incoming.seq),
    status: incoming.status,
    text,
  };
}

function mergeActions(existing: WebSearchAction[] | undefined, incoming: WebSearchAction[] | undefined): WebSearchAction[] | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  return [...(existing ?? []), ...(incoming ?? [])];
}

function addOrReplaceItem(state: TimelineState, item: TimelineItem) {
  const index = state.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    state.items[index] = mergeTimelineItem(state.items[index], item, item.debugEvents[item.debugEvents.length - 1]);
  } else {
    state.items.push(item);
    addToTurn(state, item);
  }
}

function addHiddenDebugItem(state: TimelineState, event: EventEnvelope, text?: string) {
  state.hiddenItems.push({
    ...createBaseItem(event, `debug-${event.itemId ?? event.id}`, "debug_event", eventStatus(event)),
    text: text || event.codexMethod || event.kind,
  });
}

function addToTurn(state: TimelineState, item: TimelineItem) {
  if (!item.turnId) {
    return;
  }
  const existing = state.turns.find((turn) => turn.turnId === item.turnId);
  if (existing) {
    if (!existing.itemIds.includes(item.id)) {
      existing.itemIds.push(item.id);
    }
    return;
  }
  state.turns.push({ turnId: item.turnId, itemIds: [item.id] });
}

function presentationItemId(event: EventEnvelope, itemType: string): string {
  if (itemType === "web_search_group") {
    return `web-search-${event.turnId ?? event.itemId ?? event.id}`;
  }
  return event.itemId ?? event.id;
}

function normalizedItemType(event: EventEnvelope): string {
  const method = event.codexMethod ?? "";
  const payload = payloadRecord(event.payload);
  const item = eventItem(event);
  const source = [
    method,
    stringValue(payload?.type),
    stringValue(payload?.kind),
    stringValue(item.type),
    stringValue(item.kind),
  ]
    .join(" ")
    .toLowerCase();

  if (isWarningEvent(event)) {
    return "warning";
  }
  if (isErrorEvent(event)) {
    return "error";
  }
  if (source.includes("agentmessage") || source.includes("agent_message")) {
    return "assistant_message";
  }
  if (source.includes("usermessage") || source.includes("user_message")) {
    return "user_message";
  }
  if (source.includes("reasoning")) {
    return "reasoning_summary";
  }
  if (source.includes("websearch") || source.includes("web_search")) {
    return "web_search_group";
  }
  if (source.includes("command")) {
    return "command_execution";
  }
  if (source.includes("filechange") || source.includes("file_change")) {
    return "file_change";
  }
  if (source.includes("mcptool") || source.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (source.includes("dynamictool") || source.includes("dynamic")) {
    return "dynamic_tool_call";
  }
  return "";
}

function eventStatus(event: EventEnvelope): TimelineStatus {
  const payload = payloadRecord(event.payload);
  const item = eventItem(event);
  const status = (stringValue(item.status) || stringValue(item.phase) || stringValue(payload?.status)).toLowerCase();
  if (status.includes("fail") || status.includes("error")) {
    return "failed";
  }
  if (status.includes("wait")) {
    return "waiting";
  }
  if (status.includes("cancel")) {
    return "cancelled";
  }
  if (status.includes("approval")) {
    return "approval_required";
  }
  if (event.codexMethod === "item/completed" || event.codexMethod === "turn/completed") {
    return "completed";
  }
  return "running";
}

function isLifecycleEvent(event: EventEnvelope): boolean {
  if (event.itemId) {
    return false;
  }
  const method = event.codexMethod ?? "";
  return (
    method.startsWith("turn/") ||
    method.startsWith("thread/") ||
    method.includes("token") ||
    method.includes("usage") ||
    !method
  );
}

function isWarningEvent(event: EventEnvelope): boolean {
  const source = `${event.kind} ${event.codexMethod ?? ""}`.toLowerCase();
  return source.includes("warning") || source.includes("warn");
}

function isErrorEvent(event: EventEnvelope): boolean {
  const source = `${event.kind} ${event.codexMethod ?? ""}`.toLowerCase();
  return source.includes("error") || source.includes("failed");
}

function eventItem(event: EventEnvelope): Record<string, unknown> {
  const payload = payloadRecord(event.payload);
  return payloadRecord(payload?.item) ?? payload ?? {};
}

function payloadText(payload: unknown): string {
  const record = payloadRecord(payload);
  if (!record) {
    return "";
  }

  for (const key of ["delta", "text", "message", "content"]) {
    const value = textValue(record[key]);
    if (value) {
      return value;
    }
  }

  const item = payloadRecord(record.item);
  if (item) {
    for (const key of ["text", "message", "content"]) {
      const value = textValue(item[key]);
      if (value) {
        return value;
      }
    }
    const contentText = contentArrayText(item.content);
    if (contentText) {
      return contentText;
    }
  }

  const contentText = contentArrayText(record.content);
  if (contentText) {
    return contentText;
  }

  return "";
}

function reasoningSummary(payload: unknown): string {
  const item = eventPayloadItem(payload);
  for (const key of ["summary", "text", "content"]) {
    const value = textValue(item[key]);
    if (value) {
      return value;
    }
  }
  const contentText = contentArrayText(item.content);
  if (contentText) {
    return contentText;
  }
  const summary = item.summary ?? payloadRecord(payload)?.summary;
  if (Array.isArray(summary)) {
    return summary.map((value) => (typeof value === "string" ? value : summarizeValue(value))).filter(Boolean).join("\n");
  }
  return "";
}

function webSearchAction(payload: unknown): WebSearchAction | null {
  const item = eventPayloadItem(payload);
  const action = payloadRecord(item.action) ?? payloadRecord(payloadRecord(payload)?.action);
  if (!action) {
    return null;
  }
  const kind = (stringValue(action.type) || stringValue(action.kind) || stringValue(action.action)).toLowerCase();
  if (kind.includes("search")) {
    const query = stringValue(action.query) || stringValue(action.q);
    return query ? { kind: "search", query } : null;
  }
  if (kind.includes("open")) {
    const title = stringValue(action.title);
    const url = stringValue(action.url) || stringValue(action.uri);
    return title || url ? { kind: "open", title: title || undefined, url: url || undefined } : null;
  }
  return null;
}

function actionLabel(action: WebSearchAction | null): string {
  if (!action) {
    return "";
  }
  if (action.kind === "search") {
    return `Searched web for "${action.query}"`;
  }
  if (action.kind === "open") {
    return `Opened page ${action.title || action.url || ""}`.trim();
  }
  return action.label;
}

function eventPayloadItem(payload: unknown): Record<string, unknown> {
  const record = payloadRecord(payload);
  return payloadRecord(record?.item) ?? record ?? {};
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 4).map(summarizeValue).filter(Boolean).join(", ");
  }
  const record = payloadRecord(value);
  if (!record) {
    return "";
  }
  const entries = Object.entries(record).slice(0, 4);
  return entries.map(([key, entry]) => `${key}: ${summarizeValue(entry)}`).join(", ");
}

function contentArrayText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const record = payloadRecord(entry);
      return textValue(record?.text) || textValue(record?.content);
    })
    .filter(Boolean)
    .join("\n");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}
