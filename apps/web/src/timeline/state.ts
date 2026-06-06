import type {
  EventEnvelope,
  PendingTimelineRequestSummary,
  ThreadTimelineFileChangeEntry,
  TimelineFileAttachment,
  TimelineSkillMention,
} from "../api/client";

export type TimelineStatus = "running" | "completed" | "failed" | "waiting" | "cancelled" | "approval_required";
type TimelineItemSource = "app_server" | "optimistic";
type TimelineConfirmationState = "uploading" | "sending" | "sent" | "failed";

export type WebSearchAction =
  | { kind: "search"; query: string }
  | { kind: "open"; title?: string; url?: string }
  | { kind: "other"; label: string };

export type TimelineCollabAgent = {
  threadId: string;
  displayName: string;
  nickname?: string;
  role?: string;
  status?: string;
  rawStatus?: string;
  message?: string;
  nameSource?: "metadata" | "role" | "ordinal";
};

export type TimelineCollabAgentPresentation = {
  agents: TimelineCollabAgent[];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
};

export type TimelineItem = {
  id: string;
  serverItemId?: string;
  kind: string;
  status: TimelineStatus;
  text: string;
  turnId: string | null;
  displayOrder: number;
  timestampMs?: number;
  payload: unknown;
  debugEvents: EventEnvelope[];
  action?: string;
  actions?: WebSearchAction[];
  argsSummary?: string;
  command?: string;
  cwd?: string;
  output?: string;
  path?: string;
  imageSrc?: string;
  messagePhase?: string;
  resultSummary?: string;
  summary?: string;
  toolName?: string;
  images?: TimelineImage[];
  fileAttachments?: TimelineFileAttachment[];
  skillMentions?: TimelineSkillMention[];
  source?: TimelineItemSource;
  clientRequestId?: string;
  confirmationState?: TimelineConfirmationState;
  error?: string;
  collab?: TimelineCollabAgentPresentation;
};

export type TimelineImage = {
  url?: string;
  path?: string;
};

export type TimelineTurn = {
  turnId: string;
  // Membership list for turn bookkeeping; render order is owned by TimelineItem.displayOrder.
  itemIds: string[];
  status?: string;
  startedAtMs?: number;
  completedAtMs?: number;
};

type TimelineRowDivider = "final_response";

export type TimelineFileChangeEntry = ThreadTimelineFileChangeEntry;

type TimelineItemRow = {
  type: "item";
  key: string;
  turnKey: string;
  turnId: string | null;
  displayOrder: number;
  item: TimelineItem;
  dividerBefore?: TimelineRowDivider;
};

type TimelineActivityRow = {
  type: "activity";
  key: string;
  turnKey: string;
  turnId: string | null;
  displayOrder: number;
  items: TimelineItem[];
  dividerBefore?: TimelineRowDivider;
};

export type TimelineFileChangesRow = {
  type: "file_changes";
  key: string;
  turnKey: string;
  turnId: string | null;
  entries: TimelineFileChangeEntry[];
  itemIds: string[];
  displayOrder: number;
  dividerBefore?: TimelineRowDivider;
};

export type TimelineWorkRow = {
  type: "work";
  key: string;
  turnKey: string;
  turnId: string;
  state: "running" | "completed";
  startedAtMs?: number;
  completedAtMs?: number;
  collapsedRows: Array<TimelineItemRow | TimelineActivityRow | TimelineFileChangesRow>;
  displayOrder: number;
};

export type TimelineRow = TimelineItemRow | TimelineActivityRow | TimelineFileChangesRow | TimelineWorkRow;

export type TimelineState = {
  activeTurnId: string | null;
  rows: TimelineRow[];
  items: TimelineItem[];
  hiddenItems: TimelineItem[];
  turns: TimelineTurn[];
  pendingApprovalRequests: PendingTimelineRequestSummary[];
  pendingUserInputRequests: PendingTimelineRequestSummary[];
  olderCursor: string | null;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  lastSeq: number;
  viewRevision: number;
};

export type TimelineIndexes = {
  itemIds: string[];
  itemById: Map<string, TimelineItem>;
  itemUpdatesById: Map<string, TimelineItem>;
  pendingItemById: Map<string, TimelineItem>;
  hiddenItems: TimelineItem[];
  rowKeys: string[];
  rowByKey: Map<string, TimelineRow>;
  rowKeysByItemId: Map<string, Set<string>>;
  rowKeysByTurnId: Map<string, Set<string>>;
  optimisticUserRowKeysByText: Map<string, Set<string>>;
  turnIds: string[];
  turnById: Map<string, TimelineTurn>;
  turnUpdatesById: Map<string, TimelineTurn>;
};

export type TimelineDraft = {
  activeTurnId: string | null;
  indexes: TimelineIndexes;
  pendingApprovalRequests?: PendingTimelineRequestSummary[];
  pendingUserInputRequests?: PendingTimelineRequestSummary[];
  rows?: TimelineRow[];
  rowsAreIndexed?: boolean;
  olderCursor?: string | null;
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  lastSeq: number;
  viewRevision: number;
};

const stateIndexes = new WeakMap<TimelineState, TimelineIndexes>();
const STORE_COMPACT_THRESHOLD = 256;

export function createTimelineState(): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: null,
    indexes: createEmptyTimelineIndexes(),
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    olderCursor: null,
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    lastSeq: 0,
    viewRevision: 0,
  });
}

export function createTimelineStateFromDraft(draft: TimelineDraft): TimelineState {
  const rows = draft.rows ?? orderedRows(draft.indexes.rowKeys, draft.indexes);
  if (!draft.rowsAreIndexed) {
    syncRowsToIndexes(draft.indexes, rows);
  }
  const state = {
    activeTurnId: draft.activeTurnId,
    rows,
    pendingApprovalRequests: draft.pendingApprovalRequests ?? [],
    pendingUserInputRequests: draft.pendingUserInputRequests ?? [],
    olderCursor: draft.olderCursor ?? null,
    hasOlderHistory: draft.hasOlderHistory ?? false,
    isLoadingOlderHistory: draft.isLoadingOlderHistory ?? false,
    lastSeq: draft.lastSeq,
    viewRevision: draft.viewRevision,
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

export function createEmptyTimelineIndexes(): TimelineIndexes {
  return {
    itemIds: [],
    itemById: new Map(),
    itemUpdatesById: new Map(),
    pendingItemById: new Map(),
    hiddenItems: [],
    rowKeys: [],
    rowByKey: new Map(),
    rowKeysByItemId: new Map(),
    rowKeysByTurnId: new Map(),
    optimisticUserRowKeysByText: new Map(),
    turnIds: [],
    turnById: new Map(),
    turnUpdatesById: new Map(),
  };
}

export function indexesForState(state: TimelineState): TimelineIndexes {
  return stateIndexes.get(state) ?? buildTimelineIndexes(state);
}

export function prepareTimelineIndexesForUpdate(indexes: TimelineIndexes): TimelineIndexes {
  return {
    ...indexes,
    itemUpdatesById: new Map(indexes.itemUpdatesById),
    pendingItemById: new Map(indexes.pendingItemById),
    rowKeys: [...indexes.rowKeys],
    rowByKey: new Map(indexes.rowByKey),
    rowKeysByItemId: cloneRowKeySetMap(indexes.rowKeysByItemId),
    rowKeysByTurnId: cloneRowKeySetMap(indexes.rowKeysByTurnId),
    optimisticUserRowKeysByText: cloneRowKeySetMap(indexes.optimisticUserRowKeysByText),
    turnUpdatesById: new Map(indexes.turnUpdatesById),
  };
}

export function compactTimelineStores(indexes: TimelineIndexes) {
  if (indexes.itemUpdatesById.size > STORE_COMPACT_THRESHOLD) {
    indexes.itemById = new Map([...indexes.itemById, ...indexes.itemUpdatesById]);
    indexes.itemUpdatesById = new Map();
  }
  if (indexes.turnUpdatesById.size > STORE_COMPACT_THRESHOLD) {
    indexes.turnById = new Map([...indexes.turnById, ...indexes.turnUpdatesById]);
    indexes.turnUpdatesById = new Map();
  }
}

export function timelineItemById(indexes: TimelineIndexes, itemId: string): TimelineItem | undefined {
  return indexes.itemUpdatesById.get(itemId) ?? indexes.itemById.get(itemId);
}

export function timelineTurnById(indexes: TimelineIndexes, turnId: string): TimelineTurn | undefined {
  return indexes.turnUpdatesById.get(turnId) ?? indexes.turnById.get(turnId);
}

export function timelineItems(indexes: TimelineIndexes): TimelineItem[] {
  return orderedItems(indexes.itemIds, indexes);
}

export function timelineRowByKey(indexes: TimelineIndexes, rowKey: string): TimelineRow | undefined {
  return indexes.rowByKey.get(rowKey);
}

export function timelineRowKeysByItemId(indexes: TimelineIndexes, itemId: string): string[] {
  return [...(indexes.rowKeysByItemId.get(itemId) ?? [])];
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
      status: turn.status,
      startedAtMs: turn.startedAtMs,
      completedAtMs: turn.completedAtMs,
    });
  }
  syncRowsToIndexes(indexes, state.rows);
  stateIndexes.set(state, indexes);
  return indexes;
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
      turns.push({
        turnId: turn.turnId,
        itemIds: [...turn.itemIds],
        status: turn.status,
        startedAtMs: turn.startedAtMs,
        completedAtMs: turn.completedAtMs,
      });
    }
  }
  return turns;
}

function orderedRows(rowKeys: string[], indexes: TimelineIndexes): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const rowKey of rowKeys) {
    const row = indexes.rowByKey.get(rowKey);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

function syncRowsToIndexes(indexes: TimelineIndexes, rows: TimelineRow[]) {
  indexes.rowKeys = rows.map((row) => row.key);
  indexes.rowByKey = new Map(rows.map((row) => [row.key, row]));
  indexes.rowKeysByItemId = new Map();
  indexes.rowKeysByTurnId = new Map();
  indexes.optimisticUserRowKeysByText = new Map();
  for (const row of rows) {
    indexTimelineRow(indexes, row);
  }
}

function indexTimelineRow(indexes: TimelineIndexes, row: TimelineRow) {
  if (row.turnId) {
    addSetValue(indexes.rowKeysByTurnId, row.turnId, row.key);
  }
  for (const item of timelineRowItems(row)) {
    addSetValue(indexes.rowKeysByItemId, item.id, row.key);
    if (item.serverItemId) {
      addSetValue(indexes.rowKeysByItemId, item.serverItemId, row.key);
    }
    if (item.source === "optimistic" && item.kind === "user_message" && item.text) {
      addSetValue(indexes.optimisticUserRowKeysByText, item.text, row.key);
    }
  }
}

function timelineRowItems(row: TimelineRow): TimelineItem[] {
  if (row.type === "item") {
    return [row.item];
  }
  if (row.type === "activity") {
    return row.items;
  }
  if (row.type === "work") {
    return row.collapsedRows.flatMap(timelineRowItems);
  }
  return [];
}

function addSetValue(target: Map<string, Set<string>>, key: string, value: string) {
  const existing = target.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  target.set(key, new Set([value]));
}

function cloneRowKeySetMap(source: Map<string, Set<string>>): Map<string, Set<string>> {
  return new Map([...source].map(([key, value]) => [key, new Set(value)]));
}
