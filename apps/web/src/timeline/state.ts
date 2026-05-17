import type { EventEnvelope, PendingTimelineRequestSummary, TimelineSkillMention } from "../api/client";

export type TimelineStatus = "running" | "completed" | "failed" | "waiting" | "cancelled" | "approval_required";
export type TimelineItemSource = "app_server" | "optimistic";
export type TimelineConfirmationState = "uploading" | "sending" | "sent" | "failed";

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

export type TimelineState = {
  activeTurnId: string | null;
  items: TimelineItem[];
  hiddenItems: TimelineItem[];
  turns: TimelineTurn[];
  pendingApprovalRequests: PendingTimelineRequestSummary[];
  pendingUserInputRequests: PendingTimelineRequestSummary[];
  lastSeq: number;
  viewRevision: number;
};

export type TimelineIndexes = {
  itemIds: string[];
  itemById: Map<string, TimelineItem>;
  itemUpdatesById: Map<string, TimelineItem>;
  pendingItemById: Map<string, TimelineItem>;
  hiddenItems: TimelineItem[];
  turnIds: string[];
  turnById: Map<string, TimelineTurn>;
  turnUpdatesById: Map<string, TimelineTurn>;
};

export type TimelineDraft = {
  activeTurnId: string | null;
  indexes: TimelineIndexes;
  pendingApprovalRequests?: PendingTimelineRequestSummary[];
  pendingUserInputRequests?: PendingTimelineRequestSummary[];
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
    lastSeq: 0,
    viewRevision: 0,
  });
}

export function createTimelineStateFromDraft(draft: TimelineDraft): TimelineState {
  const state = {
    activeTurnId: draft.activeTurnId,
    pendingApprovalRequests: draft.pendingApprovalRequests ?? [],
    pendingUserInputRequests: draft.pendingUserInputRequests ?? [],
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

export function pendingTimelineItemById(indexes: TimelineIndexes, itemId: string): TimelineItem | undefined {
  return indexes.pendingItemById.get(itemId);
}

export function timelineTurnById(indexes: TimelineIndexes, turnId: string): TimelineTurn | undefined {
  return indexes.turnUpdatesById.get(turnId) ?? indexes.turnById.get(turnId);
}

export function timelineItems(indexes: TimelineIndexes): TimelineItem[] {
  return orderedItems(indexes.itemIds, indexes);
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
