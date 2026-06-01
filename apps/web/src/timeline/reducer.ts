import type {
  EventEnvelope,
  ThreadTimelineRow,
  ThreadTimelineSnapshot,
  ThreadTimelineSnapshotItem,
  ThreadTimelineWorkDetailRow,
  ThreadViewResponse,
  ThreadViewPatch,
  ThreadTimelineWindowPage,
  TimelineSkillMention,
} from "../api/client";
import {
  createDiagnosticItem,
  createPresentationItem,
  isErrorEvent,
  isWarningEvent,
  mergeImages,
  type TimelinePresentationItem,
} from "./presentation";
import type { CollabAgentNameMap } from "./presentationCollab";
import {
  compactTimelineStores,
  createEmptyTimelineIndexes,
  createTimelineState,
  createTimelineStateFromDraft,
  indexesForState,
  prepareTimelineIndexesForUpdate,
  timelineRowByKey,
  timelineItemById,
  timelineItems,
  timelineTurnById,
  type TimelineCollabAgent,
  type TimelineCollabAgentPresentation,
  type TimelineImage,
  type TimelineItem,
  type TimelineRow,
  type TimelineState,
  type TimelineTurn,
  type WebSearchAction,
  type TimelineDraft,
} from "./state";

export { createTimelineState } from "./state";
export type {
  TimelineConfirmationState,
  TimelineCollabAgent,
  TimelineCollabAgentPresentation,
  TimelineFileChangesRow,
  TimelineImage,
  TimelineItem,
  TimelineItemSource,
  TimelineRow,
  TimelineFileChangeEntry,
  TimelineState,
  TimelineStatus,
  TimelineTurn,
  TimelineWorkRow,
  WebSearchAction,
} from "./state";

export function applyLiveTimelineUpdate(state: TimelineState, event: EventEnvelope): TimelineState {
  // Visible lifecycle state is gateway-owned. The reducer only applies canonical
  // thread view patches; raw app-server item/turn events remain debug data.
  if (event.kind === "thread_view.refresh_required") {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }
  if (event.kind === "thread_view.patch") {
    return applyThreadViewPatch(state, event);
  }
  if (isWarningEvent(event) || isErrorEvent(event)) {
    return applyDebugEvent(state, event);
  }
  return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
}

export const applyTimelineEvent = applyLiveTimelineUpdate;

type TimelineReducerInstrumentation = {
  turnPatchIndexedRows: number;
};

const reducerInstrumentation: TimelineReducerInstrumentation = {
  turnPatchIndexedRows: 0,
};

export function getTimelineReducerInstrumentationForTest(): TimelineReducerInstrumentation {
  return { ...reducerInstrumentation };
}

export function resetTimelineReducerInstrumentationForTest() {
  reducerInstrumentation.turnPatchIndexedRows = 0;
}

export function applyDebugEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const item = createDiagnosticItem(event);
  const existingRows = state.rows.filter((row) => row.key !== `diagnostic-${item.id}`);
  const diagnosticRow: TimelineRow = {
    type: "item",
    key: `diagnostic-${item.id}`,
    turnKey: item.turnId ? `turn-${item.turnId}` : `diagnostic-${item.id}`,
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    item,
  };
  const next = rebuildTimelineRows(state, [...existingRows, diagnosticRow]);
  return withTimelineLastSeq(next, Math.max(state.lastSeq, event.seq));
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyLiveTimelineUpdate, createTimelineState());
}

export function applyTimelineSnapshot(state: TimelineState, snapshot: ThreadViewResponse): TimelineState {
  return withHistoryPageState(applyCanonicalTimelineSnapshot(state, snapshot, snapshot.timeline), snapshot.historyPage ?? null);
}

export function addOptimisticUserMessage(
  state: TimelineState,
  input: {
    clientRequestId: string;
    skillMentions?: TimelineSkillMention[];
    text: string;
    threadId: string;
  },
): TimelineState {
  const id = optimisticUserMessageId(input.clientRequestId);
  if (timelineItemById(indexesForState(state), id)) {
    return state;
  }
  const displayOrder = optimisticDisplayOrder(state);
  const item: TimelineItem = {
    id,
    clientRequestId: input.clientRequestId,
    confirmationState: "sending",
    debugEvents: [],
    displayOrder,
    kind: "user_message",
    payload: {},
    skillMentions: input.skillMentions,
    source: "optimistic",
    status: "running",
    text: input.text,
    timestampMs: Date.now(),
    turnId: null,
  };
  return rebuildTimelineRows(state, [
    ...state.rows,
    {
      displayOrder,
      item,
      key: id,
      turnId: null,
      turnKey: `optimistic-${input.threadId}`,
      type: "item",
    },
  ]);
}

export function markOptimisticUserMessageSent(state: TimelineState, clientRequestId: string): TimelineState {
  return removeOptimisticUserMessage(state, clientRequestId);
}

export function removeOptimisticUserMessage(state: TimelineState, clientRequestId: string): TimelineState {
  const id = optimisticUserMessageId(clientRequestId);
  const rows = state.rows.filter((row) => row.type !== "item" || row.item.id !== id);
  return rows.length === state.rows.length ? state : rebuildTimelineRows(state, rows);
}

export function applyTimelineHistoryWindow(state: TimelineState, snapshot: ThreadViewResponse): TimelineState {
  const revision = snapshot.timeline.viewRevision ?? 0;
  if (revision >= state.viewRevision || snapshot.historyPage?.resetWindow) {
    return applyTimelineSnapshot(state, snapshot);
  }
  const indexes = createEmptyTimelineIndexes();
  const mapped = canonicalTimelineRowsToViewRows(snapshot.thread.id, snapshot.timeline.rows ?? [], indexes);
  const existingKeys = new Set(state.rows.map((row) => row.key));
  const rows = [...mapped.rows.filter((row) => !existingKeys.has(row.key)), ...state.rows].sort(
    (left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right),
  );
  const mergedIndexes = createEmptyTimelineIndexes();
  for (const row of rows) {
    addTimelineRowItemsToIndexes(row, mergedIndexes);
  }
  mergedIndexes.hiddenItems.push(...state.hiddenItems, ...mapped.hiddenItems);
  const next = createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    indexes: mergedIndexes,
    rows,
  });
  return withHistoryPageState(next, snapshot.historyPage ?? null, {
    lastSeq: Math.max(state.lastSeq, next.lastSeq),
    viewRevision: state.viewRevision,
  });
}

export function setTimelineOlderHistoryLoading(state: TimelineState, isLoadingOlderHistory: boolean): TimelineState {
  return createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    isLoadingOlderHistory,
  });
}

function applyCanonicalTimelineSnapshot(
  state: TimelineState,
  snapshot: ThreadViewResponse,
  canonicalTimeline: ThreadTimelineSnapshot,
): TimelineState {
  const revision = canonicalTimeline.viewRevision ?? 0;
  if (revision < state.viewRevision) {
    return state;
  }
  const indexes = createEmptyTimelineIndexes();
  const { rows, hiddenItems } = canonicalTimelineRowsToViewRows(
    snapshot.thread.id,
    canonicalTimeline.rows ?? [],
    indexes,
  );
  indexes.hiddenItems.push(...hiddenItems);
  const next = createTimelineStateFromDraft({
    activeTurnId: canonicalTimeline.activeTurnId ?? null,
    indexes,
    pendingApprovalRequests: canonicalTimeline.pendingApprovalRequests ?? [],
    pendingUserInputRequests: canonicalTimeline.pendingUserInputRequests ?? [],
    rows,
    lastSeq: Math.max(state.lastSeq, revision),
    viewRevision: Math.max(state.viewRevision, revision),
  });
  return withSnapshotTurnMetadata(next, snapshot);
}

function withHistoryPageState(
  state: TimelineState,
  historyPage: ThreadTimelineWindowPage | null,
  overrides: { lastSeq?: number; viewRevision?: number } = {},
): TimelineState {
  if (!historyPage) {
    return state;
  }
  return createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    olderCursor: historyPage.olderCursor ?? null,
    hasOlderHistory: Boolean(historyPage.hasOlder),
    isLoadingOlderHistory: false,
    lastSeq: overrides.lastSeq ?? state.lastSeq,
    viewRevision: overrides.viewRevision ?? state.viewRevision,
  });
}

function canonicalTimelineRowsToViewRows(
  threadId: string,
  canonicalRows: ThreadTimelineRow[],
  indexes = createEmptyTimelineIndexes(),
): { rows: TimelineRow[]; hiddenItems: TimelineItem[] } {
  const hiddenItems: TimelineItem[] = [];
  const rows = [...canonicalRows]
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((row) => canonicalTimelineRowToViewRow(threadId, row, indexes, hiddenItems))
    .filter((row): row is TimelineRow => row !== null);
  return { rows, hiddenItems };
}

function canonicalTimelineRowToViewRow(
  threadId: string,
  row: ThreadTimelineRow | ThreadTimelineWorkDetailRow,
  indexes: ReturnType<typeof createEmptyTimelineIndexes>,
  hiddenItems: TimelineItem[],
): TimelineRow | null {
  const base = {
    key: row.id,
    turnKey: row.turnId ? `turn-${row.turnId}` : `row-${row.id}`,
    turnId: row.turnId ?? null,
    dividerBefore: row.dividerBefore === "final_response" ? ("final_response" as const) : undefined,
  };

  if (row.kind === "work" && "work" in row) {
    const workState = row.work?.state === "running" ? "running" : "completed";
    return {
      ...base,
      type: "work",
      turnId: row.turnId ?? "",
      state: workState,
      startedAtMs: unixSecondsToMs(row.work?.startedAt),
      completedAtMs: workState === "running" ? undefined : unixSecondsToMs(row.work?.completedAt),
      collapsedRows: row.collapsedRows
        .map((collapsedRow) => canonicalTimelineRowToViewRow(threadId, collapsedRow, indexes, hiddenItems))
        .filter((collapsedRow): collapsedRow is Exclude<TimelineRow, { type: "work" }> => collapsedRow !== null && collapsedRow.type !== "work"),
      displayOrder: row.displayOrder,
    };
  }

  if (row.kind === "activity") {
    const items = row.items
      .map((item) => canonicalTimelineItemToViewItem(threadId, item, indexes, hiddenItems))
      .filter((item): item is TimelineItem => item !== null);
    if (items.length === 0) {
      return null;
    }
    return { ...base, type: "activity", displayOrder: row.displayOrder, items };
  }

  if (row.kind === "file_changes") {
    return {
      ...base,
      type: "file_changes",
      entries: row.fileChanges ?? [],
      itemIds: (row.fileChanges ?? []).flatMap((entry) => entry.itemIds),
      displayOrder: row.displayOrder,
    };
  }

  if (!row.item) {
    return null;
  }
  const item = canonicalTimelineItemToViewItem(threadId, row.item, indexes, hiddenItems);
  return item ? { ...base, type: "item", displayOrder: row.displayOrder, item } : null;
}

function canonicalTimelineItemToViewItem(
  threadId: string,
  item: ThreadTimelineSnapshotItem,
  indexes: ReturnType<typeof createEmptyTimelineIndexes>,
  hiddenItems: TimelineItem[],
): TimelineItem | null {
  const event = canonicalSnapshotItemEvent(threadId, item);
  const existingItem = timelineItemById(indexes, item.id);
  const presentation = createPresentationItem(event, existingItem, {
    collabAgentNames: collabAgentNameMap(indexes),
  });
  if (!presentation || presentation.hidden) {
    hiddenItems.push(createDiagnosticItem(event));
    return null;
  }
  const nextItem = canonicalPresentationItem(presentation, item).item;
  addOrReplaceItem(
    {
      activeTurnId: null,
      indexes,
      lastSeq: 0,
      viewRevision: 0,
    },
    nextItem,
  );
  return nextItem;
}

function addTimelineRowItemsToIndexes(row: TimelineRow, indexes: ReturnType<typeof createEmptyTimelineIndexes>) {
  const draft = {
    activeTurnId: null,
    indexes,
    lastSeq: 0,
    viewRevision: 0,
  };
  if (row.type === "item") {
    addOrReplaceItem(draft, row.item);
    return;
  }
  if (row.type === "activity") {
    for (const item of row.items) {
      addOrReplaceItem(draft, item);
    }
    return;
  }
  if (row.type === "work") {
    for (const collapsedRow of row.collapsedRows) {
      addTimelineRowItemsToIndexes(collapsedRow, indexes);
    }
  }
}

function timelineRowDisplayOrder(row: TimelineRow): number {
  return row.displayOrder;
}

function canonicalSnapshotItemEvent(threadId: string, item: ThreadTimelineSnapshotItem): EventEnvelope {
  return {
    id: item.id,
    seq: item.displayOrder,
    kind: "timeline.canonical_item",
    codexMethod: item.codexMethod ?? "item/upsert",
    threadId: item.threadId ?? threadId,
    turnId: item.turnId,
    itemId: item.id,
    projectId: null,
    payload: item.payload,
    receivedAt: canonicalSnapshotItemReceivedAt(item),
  };
}

function canonicalPresentationItem(
  presentation: TimelinePresentationItem,
  item: ThreadTimelineSnapshotItem,
): TimelinePresentationItem {
  const compactItem = {
    ...presentation.item,
    debugEvents: presentation.item.debugEvents.map(compactStoredTimelineEvent),
    payload: {},
  };
  return {
    ...presentation,
    item: {
      ...compactItem,
      id: item.id,
      serverItemId: item.itemId,
      source: "app_server",
      displayOrder: item.displayOrder,
      status: canonicalTimelineStatus(item.status, presentation.item.status),
      timestampMs: item.timestampMs ?? presentation.item.timestampMs,
    },
  };
}

function canonicalTimelineStatus(status: string | undefined, fallback: TimelineItem["status"]): TimelineItem["status"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("wait")) {
    return "waiting";
  }
  if (normalized.includes("cancel")) {
    return "cancelled";
  }
  if (normalized.includes("approval")) {
    return "approval_required";
  }
  if (normalized === "completed" || normalized === "complete") {
    return "completed";
  }
  if (normalized === "running" || normalized === "streaming" || normalized === "pending") {
    return "running";
  }
  return fallback;
}

function canonicalSnapshotItemReceivedAt(item: ThreadTimelineSnapshotItem): string {
  return typeof item.timestampMs === "number" ? new Date(item.timestampMs).toISOString() : new Date(0).toISOString();
}

function applyThreadViewPatch(state: TimelineState, event: EventEnvelope): TimelineState {
  const patch = event.payload as ThreadViewPatch;
  const revision = patch.viewRevision ?? 0;
  if (event.seq < state.lastSeq) {
    return state;
  }
  if (revision <= state.viewRevision) {
    return withIgnoredProjectionPatchCursor(state, patch, event.seq);
  }
  const threadId = event.threadId ?? patch.threadId;
  if (!threadId) {
    return applyDebugEvent(state, event);
  }

  if (!isThreadViewPatchScope(patch.scope)) {
    return withTimelineLastSeq(state, Math.max(event.seq, revision));
  }

  let next = patch.scope === "lifecycle" ? state : applyCanonicalRowsPatch(state, threadId, patch);
  next = withProjectionPatchLiveState(next, patch, event.seq);
  return withTimelineLastSeq(next, Math.max(event.seq, revision));
}

function isThreadViewPatchScope(scope: ThreadViewPatch["scope"] | undefined): scope is ThreadViewPatch["scope"] {
  return scope === "full_snapshot" || scope === "turn" || scope === "lifecycle";
}

function applyCanonicalRowsPatch(state: TimelineState, threadId: string, patch: ThreadViewPatch): TimelineState {
  if (patch.scope === "full_snapshot" && !Array.isArray(patch.rows)) {
    return state;
  }
  if (patch.scope === "turn" && (!Array.isArray(patch.rows) || !Array.isArray(patch.affectedTurnIds) || patch.affectedTurnIds.length === 0)) {
    return state;
  }
  const fullRows = patch.rows;
  if (patch.scope === "full_snapshot" && Array.isArray(fullRows)) {
    const currentIndexes = createEmptyTimelineIndexes();
    const mapped = canonicalTimelineRowsToViewRows(threadId, fullRows, currentIndexes);
    const rows = preserveUnconfirmedOptimisticUserRows(state.rows, mapped.rows);
    const indexes = createEmptyTimelineIndexes();
    for (const row of rows) {
      addTimelineRowItemsToIndexes(row, indexes);
    }
    indexes.hiddenItems.push(...mapped.hiddenItems);
    return createTimelineStateFromDraft({
      ...timelineDraftFromState(state),
      indexes,
      rows,
    });
  }

  const affectedTurnIds = new Set(patch.affectedTurnIds ?? []);
  const mappedPatchRows = canonicalTimelineRowsToViewRows(threadId, patch.rows ?? [], createEmptyTimelineIndexes());
  const rows = [
    ...state.rows.filter((row) => !row.turnId || !affectedTurnIds.has(row.turnId)),
    ...mappedPatchRows.rows,
  ].sort((left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right));
  reducerInstrumentation.turnPatchIndexedRows += rows.length;
  const indexes = createEmptyTimelineIndexes();
  for (const row of rows) {
    addTimelineRowItemsToIndexes(row, indexes);
  }
  indexes.hiddenItems.push(
    ...state.hiddenItems.filter((item) => !item.turnId || !affectedTurnIds.has(item.turnId)),
    ...mappedPatchRows.hiddenItems,
  );
  return createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    indexes,
    rows,
  });
}

function withSnapshotTurnMetadata(state: TimelineState, snapshot: ThreadViewResponse): TimelineState {
  const next = timelineDraftFromState(state);
  for (const turn of snapshot.timeline.turns ?? []) {
    upsertTimelineTurnSnapshot(next, {
      turnId: turn.id,
      status: turn.status,
      startedAtMs: unixSecondsToMs(turn.startedAt),
      completedAtMs: unixSecondsToMs(turn.completedAt),
    });
  }
  return createTimelineStateFromDraft(next);
}

function withCanonicalSnapshotLiveState(
  state: TimelineState,
  timeline: ThreadTimelineSnapshot,
  lastSeq: number,
): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: timeline.activeTurnId ?? null,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    rows: state.rows,
    pendingApprovalRequests: timeline.pendingApprovalRequests ?? [],
    pendingUserInputRequests: timeline.pendingUserInputRequests ?? [],
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq,
    viewRevision: Math.max(state.viewRevision, timeline.viewRevision ?? 0),
  });
}

function withProjectionPatchLiveState(state: TimelineState, patch: ThreadViewPatch, eventSeq: number): TimelineState {
  const next = timelineDraftFromState(state);
  for (const turn of patch.turns ?? []) {
    upsertTimelineTurnSnapshot(next, {
      turnId: turn.id,
      status: turn.status,
      startedAtMs: unixSecondsToMs(turn.startedAt),
      completedAtMs: unixSecondsToMs(turn.completedAt),
    });
  }
  if (patch.activeTurnId === undefined && patch.liveState !== "idle") {
    return createTimelineStateFromDraft(next);
  }
  return createTimelineStateFromDraft({
    activeTurnId: patch.liveState === "idle" ? null : (patch.activeTurnId ?? state.activeTurnId),
    indexes: next.indexes,
    rows: next.rows,
    pendingApprovalRequests: patch.pendingApprovalRequests ?? state.pendingApprovalRequests,
    pendingUserInputRequests: patch.pendingUserInputRequests ?? state.pendingUserInputRequests,
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq: state.lastSeq,
    viewRevision: Math.max(state.viewRevision, patch.viewRevision ?? 0, eventSeq),
  });
}

function withIgnoredProjectionPatchCursor(
  state: TimelineState,
  patch: ThreadViewPatch,
  eventSeq: number,
): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: patch.liveState === "idle" && eventSeq >= state.lastSeq ? null : state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    rows: state.rows,
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq: Math.max(state.lastSeq, eventSeq),
    viewRevision: Math.max(state.viewRevision, patch.viewRevision ?? 0, eventSeq),
  });
}

function withTimelineLastSeq(state: TimelineState, lastSeq: number): TimelineState {
  if (state.lastSeq === lastSeq) {
    return state;
  }
  return createTimelineStateFromDraft({
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    rows: state.rows,
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq,
    viewRevision: state.viewRevision,
  });
}

function optimisticUserMessageId(clientRequestId: string): string {
  return `optimistic-user-${clientRequestId}`;
}

function optimisticDisplayOrder(state: TimelineState): number {
  const lastRowOrder = state.rows.at(-1)?.displayOrder ?? state.viewRevision ?? state.lastSeq;
  return Math.max(lastRowOrder, state.viewRevision, state.lastSeq) + 0.001;
}

function rebuildTimelineRows(state: TimelineState, rows: TimelineRow[]): TimelineState {
  const normalizedRows = [...rows].sort((left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right));
  const indexes = createEmptyTimelineIndexes();
  for (const row of normalizedRows) {
    addTimelineRowItemsToIndexes(row, indexes);
  }
  indexes.hiddenItems.push(...state.hiddenItems);
  return createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    indexes,
    rows: normalizedRows,
  });
}

function preserveUnconfirmedOptimisticUserRows(currentRows: TimelineRow[], canonicalRows: TimelineRow[]): TimelineRow[] {
  return [
    ...canonicalRows,
    ...currentRows.filter((row) => row.type === "item" && row.item.source === "optimistic" && row.item.confirmationState === "sending"),
  ];
}

function applyPresentedCanonicalItem(
  next: TimelineDraft,
  event: EventEnvelope,
  presentation: TimelinePresentationItem,
): TimelineState {
  if (presentation.hidden) {
    addHiddenDebugItem(next, event, presentation.text);
    return createTimelineStateFromDraft(next);
  }

  const existing = timelineItemById(next.indexes, presentation.item.id);
  if (existing) {
    next.indexes.itemUpdatesById.set(presentation.item.id, mergeTimelineItem(existing, presentation.item, event));
  } else {
    const sameServerItem = matchingAppServerItemByServerId(next, presentation.item);
    if (sameServerItem) {
      removeItem(next, sameServerItem.id);
    }
    addItem(next, presentation.item);
    addToTurn(next, presentation.item);
  }
  compactTimelineStores(next.indexes);

  return createTimelineStateFromDraft(next);
}

function matchingAppServerItemByServerId(state: TimelineDraft, incoming: TimelineItem): TimelineItem | undefined {
  if (!incoming.serverItemId) {
    return undefined;
  }
  return timelineItems(state.indexes).find(
    (item) =>
      item.id !== incoming.id &&
      item.source === "app_server" &&
      item.kind === incoming.kind &&
      item.turnId === incoming.turnId &&
      item.serverItemId === incoming.serverItemId,
  );
}

function mergeTimelineItem(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  const compactEvent = compactStoredTimelineEvent(event);
  return {
    ...existing,
    ...incoming,
    actions: mergeActions(existing.actions, incoming.actions),
    argsSummary: incoming.argsSummary || existing.argsSummary,
    collab: mergeCollabPresentation(existing.collab, incoming.collab),
    command: incoming.command || existing.command,
    cwd: incoming.cwd || existing.cwd,
    debugEvents: [...existing.debugEvents, compactEvent],
    imageSrc: incoming.imageSrc || existing.imageSrc,
    kind: incoming.kind === "debug_event" && existing.kind !== "debug_event" ? existing.kind : incoming.kind,
    output: incoming.output || existing.output,
    path: incoming.path || existing.path,
    messagePhase: incoming.messagePhase || existing.messagePhase,
    images: mergeImages(existing.images, incoming.images),
    skillMentions: incoming.skillMentions ?? existing.skillMentions,
    payload: compactStoredPayload(incoming),
    resultSummary: incoming.resultSummary || existing.resultSummary,
    displayOrder: incoming.displayOrder,
    timestampMs: incoming.timestampMs ?? existing.timestampMs,
    status: incoming.status,
    toolName: incoming.toolName || existing.toolName,
    text: incoming.text || existing.text,
  };
}

function collabAgentNameMap(indexes: ReturnType<typeof indexesForState>): CollabAgentNameMap {
  const names: CollabAgentNameMap = new Map();
  for (const item of timelineItems(indexes)) {
    if (item.kind !== "collab_agent_tool_call" || !item.collab) {
      continue;
    }
    for (const agent of item.collab.agents) {
      const prior = names.get(agent.threadId);
      names.set(agent.threadId, mergeCollabAgentName(prior, agent));
    }
  }
  return names;
}

function mergeCollabAgentName(
  prior: TimelineCollabAgent | undefined,
  incoming: TimelineCollabAgent,
): TimelineCollabAgent {
  if (!prior) {
    return incoming;
  }
  if (incoming.nickname || (!prior.nickname && incoming.role && incoming.nameSource !== "ordinal")) {
    return { ...prior, ...incoming };
  }
  return {
    ...incoming,
    displayName: prior.displayName,
    nameSource: prior.nameSource,
    nickname: prior.nickname,
    role: incoming.role || prior.role,
  };
}

function mergeCollabPresentation(
  existing: TimelineCollabAgentPresentation | undefined,
  incoming: TimelineCollabAgentPresentation | undefined,
): TimelineCollabAgentPresentation | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  const agentsByThreadId = new Map(existing.agents.map((agent) => [agent.threadId, agent]));
  for (const agent of incoming.agents) {
    const prior = agentsByThreadId.get(agent.threadId);
    agentsByThreadId.set(agent.threadId, prior ? { ...prior, ...agent } : agent);
  }
  return {
    agents: [...agentsByThreadId.values()],
    prompt: incoming.prompt || existing.prompt,
    model: incoming.model || existing.model,
    reasoningEffort: incoming.reasoningEffort || existing.reasoningEffort,
  };
}

function mergeActions(
  existing: WebSearchAction[] | undefined,
  incoming: WebSearchAction[] | undefined,
): WebSearchAction[] | undefined {
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

function compactStoredPayload(item: TimelineItem): unknown {
  if (item.source === "app_server") {
    return {};
  }
  return item.payload;
}

function compactStoredTimelineEvent(event: EventEnvelope): EventEnvelope {
  return {
    ...event,
    payload: {},
  };
}

function addItem(state: TimelineDraft, item: TimelineItem) {
  state.indexes.itemIds = [...state.indexes.itemIds, item.id];
  state.indexes.itemUpdatesById.set(item.id, item);
  state.indexes.itemIds = [...state.indexes.itemIds]
    .map((itemId, index) => ({ itemId, index, item: timelineItemById(state.indexes, itemId) }))
    .sort((left, right) => (left.item?.displayOrder ?? 0) - (right.item?.displayOrder ?? 0) || left.index - right.index)
    .map(({ itemId }) => itemId);
}

function removeItem(state: TimelineDraft, itemId: string) {
  const item = timelineItemById(state.indexes, itemId);
  state.indexes.itemIds = state.indexes.itemIds.filter((candidateId) => candidateId !== itemId);
  state.indexes.itemUpdatesById.delete(itemId);
  state.indexes.pendingItemById.delete(itemId);
  if (!item?.turnId) {
    return;
  }
  const turn = timelineTurnById(state.indexes, item.turnId);
  if (!turn) {
    return;
  }
  const itemIds = turn.itemIds.filter((candidateId) => candidateId !== itemId);
  if (itemIds.length > 0) {
    state.indexes.turnUpdatesById.set(item.turnId, { ...turn, itemIds });
    return;
  }
  state.indexes.turnIds = state.indexes.turnIds.filter((turnId) => turnId !== item.turnId);
  state.indexes.turnUpdatesById.delete(item.turnId);
}

function addHiddenDebugItem(state: TimelineDraft, event: EventEnvelope, text?: string) {
  state.indexes.hiddenItems = [
    ...state.indexes.hiddenItems,
    {
      ...createDiagnosticItem({
        ...event,
        kind: "gateway.warning",
        payload: { message: text || event.codexMethod || event.kind },
      }),
      id: `debug-${event.itemId ?? event.id}`,
    },
  ];
}

function addToTurn(state: TimelineDraft, item: TimelineItem) {
  if (!item.turnId) {
    return;
  }
  const existing = timelineTurnById(state.indexes, item.turnId);
  if (existing) {
    if (existing.itemIds.includes(item.id)) {
      return;
    }
    state.indexes.turnUpdatesById.set(item.turnId, {
      turnId: existing.turnId,
      itemIds: [...existing.itemIds, item.id],
      status: existing.status,
      startedAtMs: existing.startedAtMs,
      completedAtMs: existing.completedAtMs,
    });
    return;
  }
  state.indexes.turnIds = [...state.indexes.turnIds, item.turnId];
  state.indexes.turnUpdatesById.set(item.turnId, {
    turnId: item.turnId,
    itemIds: [item.id],
  });
}

type TimelineTurnSnapshotUpdate = {
  turnId: string;
  status?: string;
  startedAtMs?: number;
  completedAtMs?: number;
};

function upsertTimelineTurnSnapshot(state: TimelineDraft, update: TimelineTurnSnapshotUpdate) {
  const existing = timelineTurnById(state.indexes, update.turnId);
  if (!existing && !state.indexes.turnIds.includes(update.turnId)) {
    state.indexes.turnIds = [...state.indexes.turnIds, update.turnId];
  }
  state.indexes.turnUpdatesById.set(update.turnId, {
    turnId: update.turnId,
    itemIds: existing ? [...existing.itemIds] : [],
    status: update.status || existing?.status,
    startedAtMs: update.startedAtMs ?? existing?.startedAtMs,
    completedAtMs: update.completedAtMs ?? existing?.completedAtMs,
  });
}

function timelineDraftFromState(
  state: TimelineState,
  overrides: Partial<TimelineDraft> = {},
): TimelineDraft {
  return {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    rows: state.rows,
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq: state.lastSeq,
    viewRevision: state.viewRevision,
    ...overrides,
  };
}

function unixSecondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value * 1_000 : undefined;
}
