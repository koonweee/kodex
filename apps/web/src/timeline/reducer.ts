import type {
  EventEnvelope,
  ThreadTimelineSnapshot,
  ThreadTimelineSnapshotItem,
  ThreadViewResponse,
  ThreadViewPatch,
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
  createTimelineState,
  createTimelineStateFromDraft,
  indexesForState,
  prepareTimelineIndexesForUpdate,
  timelineItemById,
  timelineItems,
  timelineTurnById,
  type TimelineCollabAgent,
  type TimelineCollabAgentPresentation,
  type TimelineImage,
  type TimelineItem,
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
  TimelineImage,
  TimelineItem,
  TimelineItemSource,
  TimelineState,
  TimelineStatus,
  TimelineTurn,
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

export const applyTimelineEvent = applyLiveTimelineUpdate;

export function applyDebugEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const next = timelineDraftFromState(state, {
    lastSeq: Math.max(state.lastSeq, event.seq),
  });
  addOrReplaceItem(next, createDiagnosticItem(event));
  return createTimelineStateFromDraft(next);
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyLiveTimelineUpdate, createTimelineState());
}

export function applyTimelineSnapshot(state: TimelineState, snapshot: ThreadViewResponse): TimelineState {
  return applyCanonicalTimelineSnapshot(state, snapshot, snapshot.timeline);
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
  let next = createTimelineState();
  for (const item of canonicalTimelineItemsInDisplayOrder(canonicalTimeline)) {
    next = applyCanonicalSnapshotItem(next, snapshot.thread.id, item);
  }
  next = withSnapshotTurnMetadata(next, snapshot);
  return withCanonicalSnapshotLiveState(next, canonicalTimeline, Math.max(state.lastSeq, revision));
}

function canonicalTimelineItemsInDisplayOrder(timeline: ThreadTimelineSnapshot): ThreadTimelineSnapshotItem[] {
  return [...timeline.items].sort((left, right) => left.displayOrder - right.displayOrder);
}

function applyCanonicalSnapshotItem(
  state: TimelineState,
  threadId: string,
  item: ThreadTimelineSnapshotItem,
): TimelineState {
  const event = canonicalSnapshotItemEvent(threadId, item);
  const currentIndexes = indexesForState(state);
  const next = timelineDraftFromState(state, {
    indexes: prepareTimelineIndexesForUpdate(currentIndexes),
  });
  const existingItem = timelineItemById(next.indexes, item.id);
  const presentation = createPresentationItem(event, existingItem, {
    collabAgentNames: collabAgentNameMap(next.indexes),
  });
  if (!presentation) {
    addHiddenDebugItem(next, event);
    return createTimelineStateFromDraft(next);
  }

  return applyPresentedCanonicalItem(next, event, canonicalPresentationItem(presentation, item));
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
  return {
    ...presentation,
    item: {
      ...presentation.item,
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

  let next = state;
  for (const item of [...(patch.items ?? [])].sort((left, right) => left.displayOrder - right.displayOrder)) {
    next = applyCanonicalSnapshotItem(next, threadId, item);
  }
  next = removeItemsMissingFromCanonicalPatch(next, patch);
  next = withProjectionPatchLiveState(next, patch, event.seq);
  return withTimelineLastSeq(next, Math.max(event.seq, revision));
}

type ThreadViewItemDeltaPayload = {
  viewRevision?: number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  phase?: string | null;
  liveState?: string;
  activeTurnId?: string | null;
};

function applyThreadViewItemDelta(state: TimelineState, event: EventEnvelope): TimelineState {
  if (event.seq < state.lastSeq) {
    return state;
  }
  const payload = threadViewItemDeltaPayload(event.payload);
  const threadId = event.threadId ?? payload.threadId;
  const turnId = event.turnId ?? payload.turnId;
  const itemId = event.itemId ?? payload.itemId;
  if (!threadId || !turnId || !itemId) {
    return applyDebugEvent(state, event);
  }
  const next = timelineDraftFromState(state, {
    activeTurnId: payload.liveState === "idle" ? null : (payload.activeTurnId ?? turnId),
  });
  const item = applyAssistantDeltaItem(next, event, threadId, turnId, itemId, payload);
  if (item) {
    upsertTimelineTurnSnapshot(next, { turnId, status: "running" });
  }
  return createTimelineStateFromDraft({
    ...next,
    lastSeq: Math.max(state.lastSeq, event.seq),
    viewRevision: Math.max(state.viewRevision, payload.viewRevision ?? 0, event.seq),
  });
}

function applyAssistantDeltaItem(
  state: TimelineDraft,
  event: EventEnvelope,
  threadId: string,
  turnId: string,
  itemId: string,
  payload: ThreadViewItemDeltaPayload,
): TimelineItem | null {
  if (!payload.delta) {
    return null;
  }
  const id = `projection-${turnId}-${itemId}`;
  const existing = timelineItemById(state.indexes, id);
  const text = `${existing?.text ?? ""}${payload.delta}`;
  const presentationPayload = assistantDeltaPresentationPayload(turnId, itemId, text, payload.phase);
  const deltaEvent: EventEnvelope = {
    ...event,
    threadId,
    turnId,
    itemId,
    codexMethod: "thread_view/item_delta",
    payload: presentationPayload,
  };
  const item: TimelineItem = {
    ...(existing ?? {
      id,
      kind: "assistant_message",
      turnId,
      displayOrder: event.seq,
      timestampMs: eventReceivedAtMs(event),
      debugEvents: [],
      payload: presentationPayload,
      status: "running" as const,
      text: "",
    }),
    id,
    serverItemId: itemId,
    source: "app_server",
    kind: "assistant_message",
    status: "running",
    text,
    turnId,
    messagePhase: payload.phase ?? existing?.messagePhase,
    payload: presentationPayload,
    debugEvents: [...(existing?.debugEvents ?? []), deltaEvent],
  };
  if (existing) {
    state.indexes.itemUpdatesById.set(id, item);
  } else {
    addItem(state, item);
    addToTurn(state, item);
  }
  compactTimelineStores(state.indexes);
  return item;
}

function assistantDeltaPresentationPayload(
  turnId: string,
  itemId: string,
  text: string,
  phase: string | null | undefined,
) {
  const item = { id: itemId, type: "agentMessage", text, phase };
  return {
    source: "gatewayStream",
    turnId,
    itemId,
    item,
    itemSnapshot: {
      id: itemId,
      itemType: "agentMessage",
      rawPayload: item,
    },
  };
}

function threadViewItemDeltaPayload(payload: unknown): ThreadViewItemDeltaPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return payload as ThreadViewItemDeltaPayload;
}

function eventReceivedAtMs(event: EventEnvelope): number | undefined {
  const parsed = Date.parse(event.receivedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function removeItemsMissingFromCanonicalPatch(state: TimelineState, patch: ThreadViewPatch): TimelineState {
  const patchItemIds = new Set((patch.items ?? []).map((item) => item.id));
  const patchServerItemIds = new Set((patch.items ?? []).map((item) => item.itemId));
  const activeTurnId = patch.activeTurnId ?? state.activeTurnId;
  const next = timelineDraftFromState(state);
  let changed = false;
  for (const item of timelineItems(next.indexes)) {
    if (item.turnId !== activeTurnId) {
      continue;
    }
    if (patchItemIds.has(item.id) || (item.serverItemId && patchServerItemIds.has(item.serverItemId))) {
      continue;
    }
    removeItem(next, item.id);
    changed = true;
  }
  return changed ? createTimelineStateFromDraft(next) : state;
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
    pendingApprovalRequests: timeline.pendingApprovalRequests ?? [],
    pendingUserInputRequests: timeline.pendingUserInputRequests ?? [],
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
    pendingApprovalRequests: patch.pendingApprovalRequests ?? state.pendingApprovalRequests,
    pendingUserInputRequests: patch.pendingUserInputRequests ?? state.pendingUserInputRequests,
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
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
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
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    lastSeq,
    viewRevision: state.viewRevision,
  });
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
  return {
    ...existing,
    ...incoming,
    actions: mergeActions(existing.actions, incoming.actions),
    argsSummary: incoming.argsSummary || existing.argsSummary,
    collab: mergeCollabPresentation(existing.collab, incoming.collab),
    command: incoming.command || existing.command,
    cwd: incoming.cwd || existing.cwd,
    debugEvents: [...existing.debugEvents, event],
    imageSrc: incoming.imageSrc || existing.imageSrc,
    kind: incoming.kind === "debug_event" && existing.kind !== "debug_event" ? existing.kind : incoming.kind,
    output: incoming.output || existing.output,
    path: incoming.path || existing.path,
    messagePhase: incoming.messagePhase || existing.messagePhase,
    images: mergeImages(existing.images, incoming.images),
    skillMentions: incoming.skillMentions ?? existing.skillMentions,
    payload: event.payload,
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

function addItem(state: TimelineDraft, item: TimelineItem) {
  state.indexes.itemIds = [...state.indexes.itemIds, item.id];
  state.indexes.itemUpdatesById.set(item.id, item);
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
    pendingApprovalRequests: state.pendingApprovalRequests,
    pendingUserInputRequests: state.pendingUserInputRequests,
    lastSeq: state.lastSeq,
    viewRevision: state.viewRevision,
    ...overrides,
  };
}

function unixSecondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value * 1_000 : undefined;
}
