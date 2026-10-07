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
  type TimelinePresentationItem,
} from "./presentation";
import { buildTimelineIndexesFromRows, compactStoredTimelineEvent, createTimelineIndexBuilder } from "./indexBuilder";
import { threadViewProjectionRevision } from "./threadViewEvents";
import {
  compactTimelineStores,
  createTimelineState,
  createTimelineStateFromDraft,
  indexesForState,
  prepareTimelineIndexesForUpdate,
  timelineRowByKey,
  timelineRowKeysByItemId,
  timelineItemById,
  timelineTurnById,
  type TimelineItem,
  type TimelineRow,
  type TimelineState,
  type TimelineDraft,
} from "./state";

type ThreadViewPatchScope = NonNullable<ThreadViewPatch["scope"]> | "row_delta";
type ThreadViewPatchPayload = Omit<ThreadViewPatch, "scope" | "rows"> & {
  removedRowIds?: string[];
  rows?: ThreadTimelineRow[] | null;
  scope?: ThreadViewPatchScope;
};

export { createTimelineState } from "./state";
export type {
  TimelineFileChangesRow,
  TimelineImage,
  TimelineItem,
  TimelineRow,
  TimelineFileChangeEntry,
  TimelineState,
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
  if (event.kind === "thread_view.item_delta") {
    return applyThreadViewItemDelta(state, event);
  }
  if (isWarningEvent(event) || isErrorEvent(event)) {
    return applyDebugEvent(state, event);
  }
  return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
}

export function canApplyThreadViewItemDelta(state: TimelineState, event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.item_delta") {
    return canApplyThreadViewPatch(state, event);
  }
  const revision = threadViewProjectionRevision(event);
  if (revision === null) return false;
  if (revision <= state.viewRevision) return revision <= state.snapshotCoverageRevision;
  const payload = recordPayload(event.payload);
  const itemId = stringPayload(payload?.itemId) ?? event.itemId;
  const turnId = stringPayload(payload?.turnId) ?? event.turnId;
  const delta = stringPayload(payload?.delta);
  if (!itemId || !turnId || !delta) {
    return true;
  }
  const indexes = indexesForState(state);
  return timelineRowKeysByItemId(indexes, itemId).some((rowKey) => {
    const row = timelineRowByKey(indexes, rowKey);
    return row ? rowHasAppendableDeltaTarget(row, { itemId, turnId, delta }) : false;
  });
}

function canApplyThreadViewPatch(state: TimelineState, event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.patch") {
    return true;
  }
  const patch = event.payload as ThreadViewPatchPayload;
  if (patch.scope === "full_snapshot") return true;
  if ((patch.viewRevision ?? 0) <= state.viewRevision) return (patch.viewRevision ?? 0) <= state.snapshotCoverageRevision;
  if (patch.scope !== "row_delta") {
    return true;
  }
  const affectedTurnIds = new Set(patch.affectedTurnIds ?? []);
  if (affectedTurnIds.size === 0) {
    return true;
  }
  return [...affectedTurnIds].every(
    (turnId) =>
      state.rows.some((row) => row.turnId === turnId) ||
      state.hiddenItems.some((item) => item.turnId === turnId),
  );
}

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

function applyDebugEvent(state: TimelineState, event: EventEnvelope): TimelineState {
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
    clientId: input.clientRequestId,
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
  const rows = state.rows.map((row): TimelineRow =>
    row.type === "item" && row.item.source === "optimistic" && row.item.clientId === clientRequestId
      ? { ...row, item: { ...row.item, confirmationState: "sent" } }
      : row,
  );
  // HTTP acceptance can arrive before the corresponding canonical SSE batch.
  // Keep the row until replacement; a full native snapshot still governs absence.
  return rows.some((row, index) => row !== state.rows[index]) ? rebuildTimelineRows(state, rows) : state;
}

export function removeOptimisticUserMessage(state: TimelineState, clientRequestId: string): TimelineState {
  const rows = state.rows.filter((row) => row.type !== "item" || row.item.source !== "optimistic" || row.item.clientId !== clientRequestId);
  return rows.length === state.rows.length ? state : rebuildTimelineRows(state, rows);
}

export function applyTimelineHistoryWindow(state: TimelineState, snapshot: ThreadViewResponse): TimelineState {
  const revision = snapshot.timeline.viewRevision ?? 0;
  if (revision >= state.viewRevision || snapshot.historyPage?.resetWindow) {
    return applyTimelineSnapshot(state, snapshot);
  }
  const mapped = canonicalTimelineRowsToViewRows(snapshot.thread.id, snapshot.timeline.rows ?? []);
  const existingKeys = new Set(state.rows.map((row) => row.key));
  const rows = [...mapped.rows.filter((row) => !existingKeys.has(row.key)), ...removeMatchedOptimisticUserRows(state.rows, mapped.rows)].sort(
    (left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right),
  );
  const mergedIndexes = buildTimelineIndexesFromRows(rows);
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
  const builder = createTimelineIndexBuilder();
  const mapped = canonicalTimelineRowsToViewRows(
    snapshot.thread.id,
    canonicalTimeline.rows ?? [],
    builder,
  );
  const rows = preserveUnconfirmedOptimisticUserRows(state.rows, mapped.rows);
  for (const row of rows) {
    if (row.type === "item" && row.item.source === "optimistic") builder.addRow(row);
  }
  const indexes = builder.finish();
  indexes.hiddenItems.push(...mapped.hiddenItems);
  const next = createTimelineStateFromDraft({
    activeTurnId: canonicalTimeline.activeTurnId ?? null,
    indexes,
    pendingApprovalRequests: canonicalTimeline.pendingApprovalRequests ?? [],
    pendingUserInputRequests: canonicalTimeline.pendingUserInputRequests ?? [],
    rows,
    lastSeq: Math.max(state.lastSeq, revision),
    viewRevision: Math.max(state.viewRevision, revision),
    snapshotCoverageRevision: revision,
    snapshotRefillIntent: null,
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
  builder = createTimelineIndexBuilder(),
): { rows: TimelineRow[]; hiddenItems: TimelineItem[] } {
  const hiddenItems: TimelineItem[] = [];
  const rows = [...canonicalRows]
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((row) => canonicalTimelineRowToViewRow(threadId, row, builder, hiddenItems))
    .filter((row): row is TimelineRow => row !== null);
  return { rows, hiddenItems };
}

function canonicalTimelineRowToViewRow(
  threadId: string,
  row: ThreadTimelineRow | ThreadTimelineWorkDetailRow,
  builder: ReturnType<typeof createTimelineIndexBuilder>,
  hiddenItems: TimelineItem[],
): TimelineRow | null {
  const base = {
    key: row.id,
    turnKey: row.turnId ? `turn-${row.turnId}` : `row-${row.id}`,
    turnId: row.turnId ?? null,
    dividerBefore: row.dividerBefore === "final_response" ? ("final_response" as const) : undefined,
  };

  if (row.kind === "work" && "work" in row) {
    const nativeState = row.work?.state;
    const workState = nativeState === "running" || nativeState === "failed" || nativeState === "interrupted" ? nativeState : "completed";
    return {
      ...base,
      type: "work",
      turnId: row.turnId ?? "",
      state: workState,
      errorMessage: row.work?.errorMessage ?? undefined,
      startedAtMs: unixSecondsToMs(row.work?.startedAt),
      completedAtMs: workState === "running" ? undefined : unixSecondsToMs(row.work?.completedAt),
      collapsedRows: row.collapsedRows
        .map((collapsedRow) => canonicalTimelineRowToViewRow(threadId, collapsedRow, builder, hiddenItems))
        .filter((collapsedRow): collapsedRow is Exclude<TimelineRow, { type: "work" }> => collapsedRow !== null && collapsedRow.type !== "work"),
      displayOrder: row.displayOrder,
    };
  }

  if (row.kind === "activity") {
    const items = row.items
      .map((item) => canonicalTimelineItemToViewItem(threadId, item, builder, hiddenItems))
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
  const item = canonicalTimelineItemToViewItem(threadId, row.item, builder, hiddenItems);
  return item ? { ...base, type: "item", displayOrder: row.displayOrder, item } : null;
}

function canonicalTimelineItemToViewItem(
  threadId: string,
  item: ThreadTimelineSnapshotItem,
  builder: ReturnType<typeof createTimelineIndexBuilder>,
  hiddenItems: TimelineItem[],
): TimelineItem | null {
  const event = canonicalSnapshotItemEvent(threadId, item);
  const existingItem = builder.itemById(item.id);
  const presentation = createPresentationItem(event, existingItem, {
    collabAgentNames: builder.collabAgentNames(),
  });
  if (!presentation || presentation.hidden) {
    hiddenItems.push(createDiagnosticItem(event));
    return null;
  }
  const nextItem = canonicalPresentationItem(presentation, item).item;
  builder.addItem(nextItem);
  return nextItem;
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
      clientId: item.payload.itemSnapshot.clientId ?? undefined,
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
  const patch = event.payload as ThreadViewPatchPayload;
  const revision = patch.viewRevision ?? 0;
  if (revision < state.viewRevision || (revision === state.viewRevision && (patch.scope !== "full_snapshot" || revision <= state.snapshotCoverageRevision))) {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }
  const threadId = event.threadId ?? patch.threadId;
  if (!threadId) {
    return applyDebugEvent(state, event);
  }

  if (!isThreadViewPatchScope(patch.scope)) {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }
  if (patch.scope === "row_delta" && !canApplyThreadViewPatch(state, event)) {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }

  let next = patch.scope === "lifecycle" ? state : applyCanonicalRowsPatch(state, threadId, patch);
  next = withProjectionPatchLiveState(next, patch);
  return withTimelineLastSeq(next, Math.max(state.lastSeq, event.seq));
}

function applyThreadViewItemDelta(state: TimelineState, event: EventEnvelope): TimelineState {
  const revision = threadViewProjectionRevision(event);
  if (revision === null || revision <= state.viewRevision) {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }
  const payload = recordPayload(event.payload);
  const itemId = stringPayload(payload?.itemId) ?? event.itemId;
  const turnId = stringPayload(payload?.turnId) ?? event.turnId;
  const delta = stringPayload(payload?.delta);
  if (!itemId || !turnId || !delta) {
    return withTimelineLastSeq(state, Math.max(state.lastSeq, event.seq));
  }

  const indexes = indexesForState(state);
  const rowKeys = timelineRowKeysByItemId(indexes, itemId);
  if (rowKeys.length === 0) {
    return applyThreadViewDeltaRefreshRequired(state, event);
  }

  const changedRows = new Map<string, TimelineRow>();
  const changedItems = new Map<string, TimelineItem>();
  const target = { itemId, turnId, delta };
  for (const rowKey of rowKeys) {
    const row = timelineRowByKey(indexes, rowKey);
    if (!row) continue;
    const nextRow = replaceDeltaTargetInRow(row, target, (item) => {
      changedItems.set(item.id, item);
    });
    if (nextRow !== row) changedRows.set(rowKey, nextRow);
  }
  if (changedRows.size === 0) {
    return applyThreadViewDeltaRefreshRequired(state, event);
  }

  // Text-only deltas preserve row order, membership, and native turn metadata.
  // Copy the changed value stores without rebuilding historical item indexes.
  const nextIndexes = {
    ...indexes,
    itemUpdatesById: new Map([...indexes.itemUpdatesById, ...changedItems]),
    rowByKey: new Map([...indexes.rowByKey, ...changedRows]),
  };
  compactTimelineStores(nextIndexes);
  return createTimelineStateFromDraft(timelineDraftFromState(state, {
    indexes: nextIndexes,
    rows: state.rows.map((row) => changedRows.get(row.key) ?? row),
    rowsAreIndexed: true,
    lastSeq: Math.max(state.lastSeq, event.seq),
    viewRevision: revision,
  }));
}

function rowHasAppendableDeltaTarget(row: TimelineRow, target: ItemDeltaTarget): boolean {
  if (row.type === "item") {
    return isAppendableDeltaTarget(row.item, target);
  }
  if (row.type === "activity") {
    return row.items.some((item) => isAppendableDeltaTarget(item, target));
  }
  if (row.type === "work") {
    return row.collapsedRows.some((collapsedRow) => rowHasAppendableDeltaTarget(collapsedRow, target));
  }
  return false;
}

function applyThreadViewDeltaRefreshRequired(state: TimelineState, event: EventEnvelope): TimelineState {
  return applyLiveTimelineUpdate(state, {
    ...event,
    kind: "thread_view.refresh_required",
    codexMethod: "thread_view/refresh_required",
    itemId: null,
    payload: {
      threadId: event.threadId,
      reason: "item_delta_base_missing",
    },
  });
}

type ItemDeltaTarget = {
  itemId: string;
  turnId: string;
  delta: string;
};

function replaceDeltaTargetInRow(row: TimelineRow, target: ItemDeltaTarget, onApplied: (item: TimelineItem) => void): TimelineRow {
  if (row.type === "item") {
    const item = appendDeltaToItem(row.item, target);
    if (item === row.item) {
      return row;
    }
    onApplied(item);
    return { ...row, item };
  }
  if (row.type === "activity") {
    let changed = false;
    const items = row.items.map((item) => {
      const next = appendDeltaToItem(item, target);
      if (next !== item) {
        changed = true;
        onApplied(next);
      }
      return next;
    });
    if (!changed) {
      return row;
    }
    return { ...row, items };
  }
  if (row.type === "work") {
    let changed = false;
    const collapsedRows = row.collapsedRows.map((collapsedRow) => {
      const next = replaceDeltaTargetInRow(collapsedRow, target, (item) => {
        changed = true;
        onApplied(item);
      });
      return next as typeof collapsedRow;
    });
    if (!changed) {
      return row;
    }
    return { ...row, collapsedRows };
  }
  return row;
}

function appendDeltaToItem(item: TimelineItem, target: ItemDeltaTarget): TimelineItem {
  if (!isAppendableDeltaTarget(item, target)) {
    return item;
  }
  return {
    ...item,
    text: `${item.text}${target.delta}`,
  };
}

function isAppendableDeltaTarget(item: TimelineItem, target: ItemDeltaTarget): boolean {
  if (item.turnId !== target.turnId) {
    return false;
  }
  if (item.id !== target.itemId && item.serverItemId !== target.itemId) {
    return false;
  }
  if (item.kind !== "assistant_message" && item.kind !== "agent_message") {
    return false;
  }
  if (item.status !== "running") {
    return false;
  }
  return true;
}

function isThreadViewPatchScope(scope: unknown): scope is ThreadViewPatchScope {
  return scope === "full_snapshot" || scope === "turn" || scope === "lifecycle" || scope === "row_delta";
}

function applyCanonicalRowsPatch(state: TimelineState, threadId: string, patch: ThreadViewPatchPayload): TimelineState {
  if (patch.scope === "full_snapshot" && !Array.isArray(patch.rows)) {
    return state;
  }
  if (patch.scope === "turn" && (!Array.isArray(patch.rows) || !Array.isArray(patch.affectedTurnIds) || patch.affectedTurnIds.length === 0)) {
    return state;
  }
  if (patch.scope === "row_delta") {
    return applyCanonicalRowDeltaPatch(state, threadId, patch);
  }
  const fullRows = patch.rows;
  if (patch.scope === "full_snapshot" && Array.isArray(fullRows)) {
    const mapped = canonicalTimelineRowsToViewRows(threadId, fullRows);
    const rows = preserveUnconfirmedOptimisticUserRows(state.rows, mapped.rows);
    const indexes = buildTimelineIndexesFromRows(rows);
    indexes.hiddenItems.push(...mapped.hiddenItems);
    return createTimelineStateFromDraft({
      ...timelineDraftFromState(state),
      indexes,
      rows,
    });
  }

  const affectedTurnIds = new Set(patch.affectedTurnIds ?? []);
  const mappedPatchRows = canonicalTimelineRowsToViewRows(threadId, patch.rows ?? []);
  const retainedRows = removeMatchedOptimisticUserRows(
    state.rows.filter((row) => !row.turnId || !affectedTurnIds.has(row.turnId)),
    mappedPatchRows.rows,
  );
  const rows = [
    ...retainedRows,
    ...mappedPatchRows.rows,
  ].sort((left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right));
  reducerInstrumentation.turnPatchIndexedRows += rows.length;
  const indexes = buildTimelineIndexesFromRows(rows);
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

function removeMatchedOptimisticUserRows(currentRows: TimelineRow[], canonicalRows: TimelineRow[]): TimelineRow[] {
  const canonicalClientIds = new Set<string>();
  for (const row of canonicalRows) {
    for (const item of timelineItemsForRow(row)) {
      if (item.source !== "optimistic" && item.kind === "user_message" && item.clientId) {
        canonicalClientIds.add(item.clientId);
      }
    }
  }
  if (canonicalClientIds.size === 0) {
    return currentRows;
  }
  return currentRows.filter((row) => row.type !== "item" || row.item.source !== "optimistic" || !row.item.clientId || !canonicalClientIds.has(row.item.clientId));
}

function timelineItemsForRow(row: TimelineRow): TimelineItem[] {
  if (row.type === "item") {
    return [row.item];
  }
  if (row.type === "activity") {
    return row.items;
  }
  if (row.type === "work") {
    return row.collapsedRows.flatMap(timelineItemsForRow);
  }
  return [];
}

function applyCanonicalRowDeltaPatch(
  state: TimelineState,
  threadId: string,
  patch: ThreadViewPatchPayload,
): TimelineState {
  const affectedTurnIds = new Set(patch.affectedTurnIds ?? []);
  if (affectedTurnIds.size === 0) {
    return state;
  }

  const rows = dedupeCanonicalRowsById(patch.rows ?? []);
  const removedRowIds = new Set((patch.removedRowIds ?? []).filter((rowId) => typeof rowId === "string" && rowId.length > 0));
  if (rows.length === 0 && removedRowIds.size === 0) {
    return state;
  }
  if (rows.some((row) => !row.turnId || !affectedTurnIds.has(row.turnId))) {
    return state;
  }

  const changedRowIds = new Set(rows.map((row) => row.id));
  const hiddenItemIdsToReplace = new Set<string>();
  for (const row of rows) {
    for (const itemId of canonicalRowItemIds(row)) {
      hiddenItemIdsToReplace.add(itemId);
    }
  }
  for (const rowId of removedRowIds) {
    hiddenItemIdsToReplace.add(rowId);
    for (const itemId of likelyHiddenItemIdsForRemovedRowId(rowId)) {
      hiddenItemIdsToReplace.add(itemId);
    }
  }

  const mappedPatchRows = canonicalTimelineRowsToViewRows(threadId, rows);
  const mergedRows = [
    ...removeMatchedOptimisticUserRows(state.rows, mappedPatchRows.rows).filter((row) => !removedRowIds.has(row.key) && !changedRowIds.has(row.key)),
    ...mappedPatchRows.rows,
  ].sort((left, right) => timelineRowDisplayOrder(left) - timelineRowDisplayOrder(right));

  const indexes = buildTimelineIndexesFromRows(mergedRows);
  indexes.hiddenItems.push(
    ...state.hiddenItems.filter((item) => !hiddenItemIdsToReplace.has(item.id)),
    ...mappedPatchRows.hiddenItems,
  );
  return createTimelineStateFromDraft({
    ...timelineDraftFromState(state),
    indexes,
    rows: mergedRows,
  });
}

function dedupeCanonicalRowsById(rows: ThreadTimelineRow[]): ThreadTimelineRow[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function canonicalRowItemIds(row: ThreadTimelineRow | ThreadTimelineWorkDetailRow): string[] {
  const itemIds: string[] = [];
  if (row.item?.id) {
    itemIds.push(row.item.id);
  }
  for (const item of row.items ?? []) {
    if (item.id) {
      itemIds.push(item.id);
    }
  }
  if ("collapsedRows" in row) {
    for (const collapsedRow of row.collapsedRows ?? []) {
      itemIds.push(...canonicalRowItemIds(collapsedRow));
    }
  }
  return itemIds;
}

function likelyHiddenItemIdsForRemovedRowId(rowId: string): string[] {
  const ids = [rowId];
  for (const prefix of ["item-", "row-"]) {
    if (rowId.startsWith(prefix) && rowId.length > prefix.length) {
      ids.push(rowId.slice(prefix.length));
    }
  }
  return ids;
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

function withProjectionPatchLiveState(state: TimelineState, patch: ThreadViewPatchPayload): TimelineState {
  const next = timelineDraftFromState(state, {
    viewRevision: Math.max(state.viewRevision, patch.viewRevision ?? 0),
    snapshotCoverageRevision: patch.scope === "full_snapshot" ? patch.viewRevision : state.snapshotCoverageRevision,
    snapshotRefillIntent: patch.scope === "full_snapshot" ? null : state.snapshotRefillIntent,
  });
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
    ...next,
    activeTurnId: patch.liveState === "idle" ? null : (patch.activeTurnId ?? state.activeTurnId),
    pendingApprovalRequests: patch.pendingApprovalRequests ?? state.pendingApprovalRequests,
    pendingUserInputRequests: patch.pendingUserInputRequests ?? state.pendingUserInputRequests,
  });
}

export function withTimelineLastSeq(state: TimelineState, lastSeq: number): TimelineState {
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
    snapshotCoverageRevision: state.snapshotCoverageRevision,
    snapshotRefillIntent: state.snapshotRefillIntent,
  });
}

export function requireTimelineSnapshot(state: TimelineState): TimelineState {
  if (state.snapshotRefillIntent) return state;
  return createTimelineStateFromDraft(timelineDraftFromState(state, { snapshotRefillIntent: {} }));
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
  const indexes = buildTimelineIndexesFromRows(normalizedRows);
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
    ...removeMatchedOptimisticUserRows(currentRows, canonicalRows).filter((row) => row.type === "item" && row.item.source === "optimistic" && row.item.confirmationState === "sending"),
  ];
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
    indexes: overrides.indexes ?? prepareTimelineIndexesForUpdate(indexesForState(state)),
    rows: state.rows,
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    olderCursor: state.olderCursor,
    hasOlderHistory: state.hasOlderHistory,
    isLoadingOlderHistory: state.isLoadingOlderHistory,
    lastSeq: state.lastSeq,
    viewRevision: state.viewRevision,
    snapshotCoverageRevision: state.snapshotCoverageRevision,
    snapshotRefillIntent: state.snapshotRefillIntent,
    ...overrides,
  };
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringPayload(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unixSecondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value * 1_000 : undefined;
}
