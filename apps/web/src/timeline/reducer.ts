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
  messagePhase?: string;
  resultSummary?: string;
  summary?: string;
  toolName?: string;
  images?: TimelineImage[];
};

export type TimelineImage = {
  url?: string;
  path?: string;
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

type TimelineIndexes = {
  itemIds: string[];
  itemById: Map<string, TimelineItem>;
  itemUpdatesById: Map<string, TimelineItem>;
  pendingItemById: Map<string, TimelineItem>;
  hiddenItems: TimelineItem[];
  turnIds: string[];
  turnById: Map<string, TimelineTurn>;
  turnUpdatesById: Map<string, TimelineTurn>;
};

type TimelineDraft = {
  activeTurnId: string | null;
  indexes: TimelineIndexes;
  lastSeq: number;
};

const stateIndexes = new WeakMap<TimelineState, TimelineIndexes>();
const STORE_COMPACT_THRESHOLD = 256;

export function createTimelineState(): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: null,
    indexes: createEmptyTimelineIndexes(),
    lastSeq: 0,
  });
}

function createTimelineStateFromDraft(draft: TimelineDraft): TimelineState {
  const state = {
    activeTurnId: draft.activeTurnId,
    lastSeq: draft.lastSeq,
  } as TimelineState;
  let itemsCache: TimelineItem[] | null = null;
  let hiddenItemsCache: TimelineItem[] | null = null;
  let turnsCache: TimelineTurn[] | null = null;
  Object.defineProperties(state, {
    items: {
      configurable: true,
      enumerable: true,
      get: () => {
        itemsCache ??= orderedItems(draft.indexes.itemIds, draft.indexes);
        return itemsCache;
      },
    },
    hiddenItems: {
      configurable: true,
      enumerable: true,
      get: () => {
        hiddenItemsCache ??= [...draft.indexes.hiddenItems];
        return hiddenItemsCache;
      },
    },
    turns: {
      configurable: true,
      enumerable: true,
      get: () => {
        turnsCache ??= orderedTurns(draft.indexes.turnIds, draft.indexes);
        return turnsCache;
      },
    },
  });
  stateIndexes.set(state, draft.indexes);
  return state;
}

function createEmptyTimelineIndexes(): TimelineIndexes {
  return {
    itemIds: [],
    itemById: new Map(),
    itemUpdatesById: new Map(),
    pendingItemById: new Map(),
    hiddenItems: [],
    turnIds: [],
    turnById: new Map(),
    turnUpdatesById: new Map(),
  };
}

function indexesForState(state: TimelineState): TimelineIndexes {
  return stateIndexes.get(state) ?? buildTimelineIndexes(state);
}

function buildTimelineIndexes(state: TimelineState): TimelineIndexes {
  const indexes = createEmptyTimelineIndexes();
  for (const item of state.items) {
    indexes.itemIds.push(item.id);
    indexes.itemById.set(item.id, item);
  }
  indexes.hiddenItems.push(...state.hiddenItems);
  for (const turn of state.turns) {
    indexes.turnIds.push(turn.turnId);
    indexes.turnById.set(turn.turnId, {
      turnId: turn.turnId,
      itemIds: [...turn.itemIds],
    });
  }
  stateIndexes.set(state, indexes);
  return indexes;
}

function prepareTimelineIndexesForUpdate(indexes: TimelineIndexes): TimelineIndexes {
  return {
    ...indexes,
    itemUpdatesById: new Map(indexes.itemUpdatesById),
    pendingItemById: new Map(indexes.pendingItemById),
    turnUpdatesById: new Map(indexes.turnUpdatesById),
  };
}

function compactTimelineStores(indexes: TimelineIndexes) {
  if (indexes.itemUpdatesById.size > STORE_COMPACT_THRESHOLD) {
    indexes.itemById = new Map([...indexes.itemById, ...indexes.itemUpdatesById]);
    indexes.itemUpdatesById = new Map();
  }
  if (indexes.turnUpdatesById.size > STORE_COMPACT_THRESHOLD) {
    indexes.turnById = new Map([...indexes.turnById, ...indexes.turnUpdatesById]);
    indexes.turnUpdatesById = new Map();
  }
}

function timelineItemById(indexes: TimelineIndexes, itemId: string): TimelineItem | undefined {
  return indexes.itemUpdatesById.get(itemId) ?? indexes.itemById.get(itemId);
}

function pendingTimelineItemById(indexes: TimelineIndexes, itemId: string): TimelineItem | undefined {
  return indexes.pendingItemById.get(itemId);
}

function timelineTurnById(indexes: TimelineIndexes, turnId: string): TimelineTurn | undefined {
  return indexes.turnUpdatesById.get(turnId) ?? indexes.turnById.get(turnId);
}

function orderedItems(itemIds: string[], indexes: TimelineIndexes): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const itemId of itemIds) {
    const item = timelineItemById(indexes, itemId);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function orderedTurns(turnIds: string[], indexes: TimelineIndexes): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const turnId of turnIds) {
    const turn = timelineTurnById(indexes, turnId);
    if (turn) {
      turns.push({ turnId: turn.turnId, itemIds: [...turn.itemIds] });
    }
  }
  return turns;
}

export function applyTimelineEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: nextActiveTurnId(state.activeTurnId, event),
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: Math.max(state.lastSeq, event.seq),
  };

  if (event.codexMethod === "turn/completed") {
    next.activeTurnId = null;
    addHiddenDebugItem(next, event);
    return createTimelineStateFromDraft(next);
  }

  if (isLifecycleEvent(event)) {
    if (isWarningEvent(event) || isErrorEvent(event)) {
      addOrReplaceItem(next, createDiagnosticItem(event));
    } else {
      addHiddenDebugItem(next, event);
    }
    return createTimelineStateFromDraft(next);
  }

  const presentation = createPresentationItem(event);
  if (!presentation) {
    addHiddenDebugItem(next, event);
    return createTimelineStateFromDraft(next);
  }

  if (presentation.hidden) {
    if (shouldRetainPendingTimelineItem(presentation.item)) {
      retainPendingTimelineItem(next, presentation.item);
    }
    addHiddenDebugItem(next, event, presentation.text);
    return createTimelineStateFromDraft(next);
  }

  const existing = timelineItemById(next.indexes, presentation.item.id);
  if (existing) {
    next.indexes.itemUpdatesById.set(presentation.item.id, mergeTimelineItem(existing, presentation.item, event));
  } else {
    const pendingItem = pendingTimelineItemById(next.indexes, presentation.item.id);
    const item = pendingItem ? mergeTimelineItem(pendingItem, presentation.item, event) : presentation.item;
    next.indexes.pendingItemById.delete(presentation.item.id);
    addItem(next, item);
    addToTurn(next, item);
  }
  compactTimelineStores(next.indexes);

  return createTimelineStateFromDraft(next);
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyTimelineEvent, createTimelineState());
}

function nextActiveTurnId(currentTurnId: string | null, event: EventEnvelope) {
  if (event.codexMethod === "turn/completed") {
    return null;
  }
  if (!event.turnId || !eventCanMarkTurnActive(event)) {
    return currentTurnId;
  }
  return event.turnId;
}

function eventCanMarkTurnActive(event: EventEnvelope) {
  const method = event.codexMethod ?? "";
  return Boolean(event.itemId) || method.startsWith("turn/");
}

function createPresentationItem(event: EventEnvelope): { item: TimelineItem; hidden?: boolean; text?: string } | null {
  const item = eventItem(event);
  const itemType = normalizedItemType(event);
  const text = payloadText(event.payload);
  const status = eventStatus(event);
  const id = presentationItemId(event, itemType);
  const base = createBaseItem(event, id, itemType, status);

  if (itemType === "assistant_message") {
    const messagePhase = stringValue(item.phase) || stringValue(payloadRecord(event.payload)?.phase);
    return {
      item: {
        ...base,
        messagePhase,
        text,
      },
      hidden: !text,
      text: "Empty assistant message",
    };
  }

  if (itemType === "user_message") {
    const images = payloadImages(event.payload);
    return {
      item: {
        ...base,
        images,
        text,
      },
      hidden: !text && images.length === 0,
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
  const output = isCommandOutputDelta(event)
    ? (existing.output ?? "") + incoming.text
    : incoming.output || existing.output;
  return {
    ...existing,
    ...incoming,
    actions: mergeActions(existing.actions, incoming.actions),
    argsSummary: incoming.argsSummary || existing.argsSummary,
    command: incoming.command || existing.command,
    cwd: incoming.cwd || existing.cwd,
    debugEvents: [...existing.debugEvents, event],
    kind: incoming.kind === "debug_event" && existing.kind !== "debug_event" ? existing.kind : incoming.kind,
    output,
    path: incoming.path || existing.path,
    messagePhase: incoming.messagePhase || existing.messagePhase,
    images: mergeImages(existing.images, incoming.images),
    payload: event.payload,
    resultSummary: incoming.resultSummary || existing.resultSummary,
    seq: Math.min(existing.seq, incoming.seq),
    status: incoming.status,
    toolName: incoming.toolName || existing.toolName,
    text,
  };
}

function isCommandOutputDelta(event: EventEnvelope): boolean {
  return event.codexMethod === "item/commandExecution/outputDelta";
}

function mergeActions(existing: WebSearchAction[] | undefined, incoming: WebSearchAction[] | undefined): WebSearchAction[] | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  return [...(existing ?? []), ...(incoming ?? [])];
}

function addOrReplaceItem(state: TimelineDraft, item: TimelineItem) {
  const existing = timelineItemById(state.indexes, item.id);
  if (existing) {
    state.indexes.itemUpdatesById.set(item.id, mergeTimelineItem(existing, item, item.debugEvents[item.debugEvents.length - 1]));
  } else {
    addItem(state, item);
    addToTurn(state, item);
  }
  compactTimelineStores(state.indexes);
}

function addItem(state: TimelineDraft, item: TimelineItem) {
  state.indexes.itemIds = [...state.indexes.itemIds, item.id];
  state.indexes.itemUpdatesById.set(item.id, item);
}

function retainPendingTimelineItem(state: TimelineDraft, item: TimelineItem) {
  state.indexes.pendingItemById.set(item.id, item);
}

function shouldRetainPendingTimelineItem(item: TimelineItem): boolean {
  return item.kind === "assistant_message";
}

function addHiddenDebugItem(state: TimelineDraft, event: EventEnvelope, text?: string) {
  state.indexes.hiddenItems = [
    ...state.indexes.hiddenItems,
    {
      ...createBaseItem(event, `debug-${event.itemId ?? event.id}`, "debug_event", eventStatus(event)),
      text: text || event.codexMethod || event.kind,
    },
  ];
}

function addToTurn(state: TimelineDraft, item: TimelineItem) {
  if (!item.turnId) {
    return;
  }
  const existing = timelineTurnById(state.indexes, item.turnId);
  if (existing) {
    state.indexes.turnUpdatesById.set(item.turnId, {
      turnId: existing.turnId,
      itemIds: [...existing.itemIds, item.id],
    });
    return;
  }
  state.indexes.turnIds = [...state.indexes.turnIds, item.turnId];
  state.indexes.turnUpdatesById.set(item.turnId, {
    turnId: item.turnId,
    itemIds: [item.id],
  });
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

function payloadImages(payload: unknown): TimelineImage[] {
  const images: TimelineImage[] = [];
  for (const value of candidateImageContainers(payload)) {
    collectImages(value, images);
  }
  return dedupeImages(images);
}

function candidateImageContainers(payload: unknown): unknown[] {
  const record = payloadRecord(payload);
  const item = payloadRecord(record?.item);
  return [payload, record?.content, record?.input, item, item?.content, item?.input].filter(Boolean);
}

function collectImages(value: unknown, images: TimelineImage[]) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImages(entry, images);
    }
    return;
  }
  const record = payloadRecord(value);
  if (!record) {
    return;
  }
  const type = stringValue(record.type);
  const url = stringValue(record.url) || stringValue(record.imageUrl) || stringValue(record.image_url);
  const path = stringValue(record.path);
  if ((type === "image" || type === "inputImage" || type === "input_image" || url || path) && (url || path)) {
    images.push({ url: url || undefined, path: path || undefined });
  }
}

function dedupeImages(images: TimelineImage[]): TimelineImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.url || image.path;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mergeImages(existing?: TimelineImage[], incoming?: TimelineImage[]) {
  return dedupeImages([...(existing ?? []), ...(incoming ?? [])]);
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
