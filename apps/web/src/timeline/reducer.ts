import type {
  EventEnvelope,
  ThreadDetailResponse,
  ThreadTimelineSnapshot,
  ThreadTimelineSnapshotItem,
  TimelineProjectionPatch,
  TimelineSkillMention,
} from "../api/client";
import {
  createBaseItem,
  createDiagnosticItem,
  createPresentationItem,
  eventStatus,
  isErrorEvent,
  isLifecycleEvent,
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
  pendingTimelineItemById,
  prepareTimelineIndexesForUpdate,
  timelineItemById,
  timelineItems,
  timelineTurnById,
  type OptimisticUserMessageInput,
  type OptimisticUserMessageUpdate,
  type TimelineDraft,
  type TimelineIndexes,
  type TimelineCollabAgent,
  type TimelineCollabAgentPresentation,
  type TimelineImage,
  type TimelineItem,
  type TimelineState,
  type TimelineTurn,
  type WebSearchAction,
} from "./state";

export { createTimelineState } from "./state";
export type {
  OptimisticUserMessageInput,
  OptimisticUserMessageUpdate,
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

const LIVE_TIMELINE_EVENT_KINDS = new Set([
  "timeline.projection_patch",
  "timeline.turn_upsert",
  "timeline.thread_status",
]);

type TimelineEventApplyOptions = {
  disableEquivalentCompletedItemMatch?: boolean;
  skipOptimisticUserMessageMatch?: boolean;
  preserveIncomingDisplayOrderOnConfirm?: boolean;
};

export function applyLiveTimelineUpdate(state: TimelineState, event: EventEnvelope): TimelineState {
  if (event.kind === "timeline.snapshot_required") {
    return state;
  }
  if (event.kind === "timeline.snapshot") {
    return applyTimelineSnapshot(state, event.payload as ThreadDetailResponse);
  }
  if (event.kind === "timeline.projection_patch") {
    return applyTimelineProjectionPatch(state, event);
  }
  if (!LIVE_TIMELINE_EVENT_KINDS.has(event.kind)) {
    return applyDebugEvent(state, event);
  }
  return applyTimelineEventInternal(state, event);
}

export function applyDebugEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: Math.max(state.lastSeq, event.seq),
    projectionRevision: state.projectionRevision,
  };
  if (isWarningEvent(event) || isErrorEvent(event)) {
    addOrReplaceItem(next, createDiagnosticItem(event));
  } else {
    addHiddenDebugItem(next, event);
  }
  return createTimelineStateFromDraft(next);
}

export function applyTimelineEvent(state: TimelineState, event: EventEnvelope): TimelineState {
  return applyTimelineEventInternal(state, event);
}

function applyTimelineEventInternal(
  state: TimelineState,
  event: EventEnvelope,
  options: TimelineEventApplyOptions = {},
): TimelineState {
  if (event.kind === "timeline.snapshot") {
    return applyTimelineSnapshot(state, event.payload as ThreadDetailResponse);
  }

  const currentIndexes = indexesForState(state);
  const next: TimelineDraft = {
    activeTurnId: nextActiveTurnId(state.activeTurnId, event, currentIndexes),
    indexes: prepareTimelineIndexesForUpdate(currentIndexes),
    lastSeq: Math.max(state.lastSeq, event.seq),
    projectionRevision: state.projectionRevision,
  };
  if (event.kind === "timeline.turn_upsert") {
    upsertTimelineTurn(next, event);
  }

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

  return applyTimelineItemEventToDraft(state, next, event, options);
}

export function addOptimisticUserMessage(state: TimelineState, input: OptimisticUserMessageInput): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  const item: TimelineItem = {
    id: `optimistic-${input.clientRequestId}`,
    kind: "user_message",
    status: input.confirmationState === "failed" ? "failed" : "completed",
    text: input.text,
    turnId: input.turnId,
    displayOrder: nextOptimisticDisplayOrder(next.indexes),
    timestampMs: Date.now(),
    payload: { optimistic: true },
    debugEvents: [],
    images: input.images,
    skillMentions: input.skillMentions,
    source: "optimistic",
    clientRequestId: input.clientRequestId,
    confirmationState: input.confirmationState,
  };
  const existing = matchingOptimisticUserMessage(next.indexes, item);
  if (existing) {
    next.indexes.itemUpdatesById.set(existing.id, {
      ...item,
      id: existing.id,
      displayOrder: existing.displayOrder,
      timestampMs: existing.timestampMs ?? item.timestampMs,
    });
    return createTimelineStateFromDraft(next);
  }
  addItem(next, item);
  addToTurn(next, item);
  return createTimelineStateFromDraft(next);
}

export function updateOptimisticUserMessage(
  state: TimelineState,
  clientRequestId: string,
  update: OptimisticUserMessageUpdate,
): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  const item = timelineItems(next.indexes).find((candidate) => candidate.clientRequestId === clientRequestId);
  if (!item) {
    return state;
  }
  const confirmationState = update.confirmationState ?? item.confirmationState;
  next.indexes.itemUpdatesById.set(item.id, {
    ...item,
    ...update,
    status: confirmationState === "failed" ? "failed" : "completed",
  });
  return createTimelineStateFromDraft(next);
}

export function removeOptimisticUserMessage(state: TimelineState, clientRequestId: string): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  const item = timelineItems(next.indexes).find(
    (candidate) => candidate.source === "optimistic" && candidate.clientRequestId === clientRequestId,
  );
  if (!item) {
    return state;
  }

  removeItem(next, item.id);

  return createTimelineStateFromDraft(next);
}

export function replayTimeline(events: EventEnvelope[]): TimelineState {
  return events.reduce(applyTimelineEvent, createTimelineState());
}

export function applyTimelineSnapshot(state: TimelineState, snapshot: ThreadDetailResponse): TimelineState {
  return applyCanonicalTimelineSnapshot(state, snapshot, snapshot.timeline);
}

function applyCanonicalTimelineSnapshot(
  state: TimelineState,
  snapshot: ThreadDetailResponse,
  canonicalTimeline: ThreadTimelineSnapshot,
): TimelineState {
  if ((canonicalTimeline.revision ?? 0) < state.projectionRevision) {
    return state;
  }
  let next = optimisticOnlyTimeline(state);
  let displayOrder = 0;
  for (const item of canonicalTimelineItemsInDisplayOrder(canonicalTimeline)) {
    displayOrder = Math.max(displayOrder, item.displayOrder);
    next = applyCanonicalSnapshotItem(next, snapshot.thread.id, item, {
      allowOptimisticUserMessageMatch: false,
      knownAppServerItemIds: new Set(),
    });
  }
  next = moveUnmatchedLocalUserMessagesAfterSnapshot(next, displayOrder);
  next = withSnapshotTurnMetadata(next, snapshot);
  next = withCanonicalSnapshotLiveState(next, canonicalTimeline);
  return withTimelineLastSeq(next, Math.max(state.lastSeq, canonicalTimeline.revision ?? 0));
}

function canonicalTimelineItemsInDisplayOrder(timeline: ThreadTimelineSnapshot): ThreadTimelineSnapshotItem[] {
  return [...timeline.items].sort((left, right) => left.displayOrder - right.displayOrder);
}

function applyCanonicalSnapshotItem(
  state: TimelineState,
  threadId: string,
  item: ThreadTimelineSnapshotItem,
  options: { allowOptimisticUserMessageMatch: boolean; knownAppServerItemIds: Set<string> },
): TimelineState {
  const event = canonicalSnapshotItemEvent(threadId, item);
  const currentIndexes = indexesForState(state);
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(currentIndexes),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  return applyTimelineItemEventToDraft(state, next, event, {
    disableEquivalentCompletedItemMatch: true,
    preserveIncomingDisplayOrderOnConfirm: true,
    skipOptimisticUserMessageMatch: canonicalItemShouldSkipLocalUserMessageMatch(item, options),
  });
}

function canonicalItemShouldSkipLocalUserMessageMatch(
  item: ThreadTimelineSnapshotItem,
  options: { allowOptimisticUserMessageMatch: boolean; knownAppServerItemIds: Set<string> },
): boolean {
  if (!item.itemType.toLowerCase().includes("user")) {
    return false;
  }
  return !options.allowOptimisticUserMessageMatch || options.knownAppServerItemIds.has(item.itemId);
}

function canonicalSnapshotItemEvent(threadId: string, item: ThreadTimelineSnapshotItem): EventEnvelope {
  return {
    id: item.id,
    seq: item.displayOrder,
    kind: "timeline.item_upsert",
    codexMethod: item.codexMethod ?? "item/upsert",
    threadId: item.threadId ?? threadId,
    turnId: item.turnId,
    itemId: item.itemId,
    projectId: null,
    payload: item.payload,
    receivedAt: canonicalSnapshotItemReceivedAt(item),
  };
}

function canonicalSnapshotItemReceivedAt(item: ThreadTimelineSnapshotItem): string {
  return typeof item.timestampMs === "number" ? new Date(item.timestampMs).toISOString() : new Date(0).toISOString();
}

function applyTimelineProjectionPatch(state: TimelineState, event: EventEnvelope): TimelineState {
  if (event.seq <= state.lastSeq) {
    return state;
  }
  const patch = event.payload as TimelineProjectionPatch;
  if ((patch.revision ?? 0) <= state.projectionRevision) {
    return withIgnoredProjectionPatchCursor(state, patch, event.seq);
  }
  const threadId = event.threadId ?? patch.threadId;
  if (!threadId) {
    return applyDebugEvent(state, event);
  }

  let next = state;
  for (const item of [...(patch.items ?? [])].sort((left, right) => left.displayOrder - right.displayOrder)) {
    next = applyCanonicalSnapshotItem(next, threadId, item, {
      allowOptimisticUserMessageMatch: true,
      knownAppServerItemIds: appServerItemIdsForState(next),
    });
  }
  next = withProjectionPatchLiveState(next, patch, event.seq);
  return withTimelineLastSeq(next, Math.max(event.seq, patch.revision ?? 0));
}

function appServerItemIdsForState(state: TimelineState): Set<string> {
  const itemIds = new Set<string>();
  for (const item of state.items) {
    if (item.source === "optimistic" && !item.serverItemId) {
      continue;
    }
    itemIds.add(item.serverItemId ?? item.id);
  }
  return itemIds;
}

function optimisticOnlyTimeline(state: TimelineState): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: null,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(createTimelineState())),
    lastSeq: 0,
    projectionRevision: state.projectionRevision,
  };
  for (const item of state.items) {
    if (!shouldCarryLocalUserMessageAcrossSnapshot(item)) {
      continue;
    }
    addItem(next, item);
    addToTurn(next, item);
  }
  return createTimelineStateFromDraft(next);
}

function shouldCarryLocalUserMessageAcrossSnapshot(item: TimelineItem): boolean {
  const hasSkillMentions = (item.skillMentions ?? []).length > 0;
  return (
    item.kind === "user_message" &&
    Boolean(item.clientRequestId) &&
    item.source === "optimistic" &&
    !item.serverItemId &&
    item.confirmationState !== "sent" &&
    (item.confirmationState !== "failed" || hasSkillMentions)
  );
}

function moveUnmatchedLocalUserMessagesAfterSnapshot(state: TimelineState, snapshotMaxDisplayOrder: number): TimelineState {
  if (snapshotMaxDisplayOrder <= 0) {
    return state;
  }

  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  let displayOrder = snapshotMaxDisplayOrder;
  let changed = false;
  for (const item of timelineItems(next.indexes)) {
    if (!shouldMoveLocalUserMessageAfterSnapshot(item, snapshotMaxDisplayOrder)) {
      continue;
    }
    displayOrder += 0.1;
    next.indexes.itemUpdatesById.set(item.id, { ...item, displayOrder });
    changed = true;
  }
  return changed ? createTimelineStateFromDraft(next) : state;
}

function withSnapshotTurnMetadata(state: TimelineState, snapshot: ThreadDetailResponse): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: state.projectionRevision,
  };
  for (const turn of snapshot.turns) {
    upsertTimelineTurnSnapshot(next, {
      turnId: turn.id,
      status: turn.status,
      startedAtMs: unixSecondsToMs(turn.startedAt),
      completedAtMs: unixSecondsToMs(turn.completedAt),
    });
  }
  return createTimelineStateFromDraft(next);
}

function shouldMoveLocalUserMessageAfterSnapshot(item: TimelineItem, snapshotMaxDisplayOrder: number): boolean {
  return (
    shouldCarryLocalUserMessageAcrossSnapshot(item) &&
    item.displayOrder <= snapshotMaxDisplayOrder &&
    !item.serverItemId
  );
}

function withCanonicalSnapshotLiveState(state: TimelineState, timeline: ThreadTimelineSnapshot): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: timeline.activeTurnId ?? null,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: Math.max(state.projectionRevision, timeline.revision ?? 0),
  });
}

function withProjectionPatchLiveState(state: TimelineState, patch: TimelineProjectionPatch, eventSeq: number): TimelineState {
  if (patch.activeTurnId === undefined && patch.liveState !== "idle") {
    return state;
  }
  return createTimelineStateFromDraft({
    activeTurnId: patch.liveState === "idle" ? null : (patch.activeTurnId ?? state.activeTurnId),
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
    projectionRevision: Math.max(state.projectionRevision, patch.revision ?? 0, eventSeq),
  });
}

function withIgnoredProjectionPatchCursor(
  state: TimelineState,
  patch: TimelineProjectionPatch,
  eventSeq: number,
): TimelineState {
  return createTimelineStateFromDraft({
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: Math.max(state.lastSeq, eventSeq),
    projectionRevision: Math.max(state.projectionRevision, patch.revision ?? 0, eventSeq),
  });
}

function withTimelineLastSeq(state: TimelineState, lastSeq: number): TimelineState {
  if (state.lastSeq === lastSeq) {
    return state;
  }
  return createTimelineStateFromDraft({
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq,
    projectionRevision: state.projectionRevision,
  });
}

function nextActiveTurnId(currentTurnId: string | null, event: EventEnvelope, indexes: TimelineIndexes) {
  if (event.codexMethod === "turn/completed") {
    return null;
  }
  if (event.kind === "timeline.turn_upsert") {
    if (historicalTurnUpsertWouldReactivateCompletedTurn(indexes, event)) {
      return currentTurnId;
    }
    if (timelineTurnUpsertIsActive(event)) {
      return event.turnId ?? currentTurnId;
    }
    return event.turnId === currentTurnId ? null : currentTurnId;
  }
  if (!event.turnId || !eventCanMarkTurnActive(event)) {
    return currentTurnId;
  }
  return event.turnId;
}

function historicalTurnUpsertWouldReactivateCompletedTurn(indexes: TimelineIndexes, event: EventEnvelope): boolean {
  if (!event.turnId || !timelineTurnUpsertIsActive(event)) {
    return false;
  }
  const turn = timelineTurnById(indexes, event.turnId);
  if (!turn || turn.itemIds.length === 0) {
    return false;
  }
  return turn.itemIds.every((itemId) => {
    const item = timelineItemById(indexes, itemId);
    return item ? isTerminalTurnStatus(item.status) : false;
  });
}

function timelineTurnUpsertIsActive(event: EventEnvelope): boolean {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : null;
  const turn = payload?.turn && typeof payload.turn === "object" ? (payload.turn as Record<string, unknown>) : null;
  const status = typeof turn?.status === "string" ? turn.status.toLowerCase() : "";
  if (status) {
    return !isTerminalTurnStatus(status);
  }
  const liveState = typeof payload?.liveState === "string" ? payload.liveState : "";
  return liveState === "streaming" || liveState === "syncing";
}

function isTerminalTurnStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "canceled", "interrupted"].includes(status.toLowerCase());
}

function eventCanMarkTurnActive(event: EventEnvelope) {
  const method = event.codexMethod ?? "";
  if (method === "item/completed" || method === "item/upsert") {
    return false;
  }
  return method.endsWith("/delta") || method === "item/started" || method.startsWith("turn/");
}

function applyTimelineItemEventToDraft(
  state: TimelineState,
  next: TimelineDraft,
  event: EventEnvelope,
  options: TimelineEventApplyOptions,
): TimelineState {
  const existingItem = event.itemId ? timelineItemById(next.indexes, event.itemId) : undefined;
  const presentation = createPresentationItem(event, existingItem, {
    collabAgentNames: collabAgentNameMap(next.indexes),
  });
  if (!presentation) {
    addHiddenDebugItem(next, event);
    return createTimelineStateFromDraft(next);
  }

  return applyPresentedTimelineItem(state, next, event, presentation, options);
}

function applyPresentedTimelineItem(
  state: TimelineState,
  next: TimelineDraft,
  event: EventEnvelope,
  presentation: TimelinePresentationItem,
  options: TimelineEventApplyOptions,
): TimelineState {
  if (presentation.hidden) {
    if (shouldRetainPendingTimelineItem(presentation.item)) {
      retainPendingTimelineItem(next, presentation.item);
    }
    addHiddenDebugItem(next, event, presentation.text);
    return createTimelineStateFromDraft(next);
  }

  const existing = timelineItemById(next.indexes, presentation.item.id);
  const completedReplayDeltaItem =
    existing && shouldIgnoreCompletedReplayDelta(state.activeTurnId, existing, presentation.item, event)
      ? existing
      : matchingCompletedReplayDeltaItem(next.indexes, state.activeTurnId, presentation.item, event);
  if (completedReplayDeltaItem) {
    next.activeTurnId = state.activeTurnId;
    next.indexes.itemUpdatesById.set(completedReplayDeltaItem.id, appendTimelineDebugEvent(completedReplayDeltaItem, event));
    return createTimelineStateFromDraft(next);
  }

  if (existing) {
    next.indexes.itemUpdatesById.set(presentation.item.id, mergeTimelineItem(existing, presentation.item, event));
  } else {
    const exactConfirmedUserItem =
      presentation.item.kind === "user_message" ? matchingConfirmedUserMessage(next.indexes, presentation.item) : undefined;
    const optimisticItem =
      !exactConfirmedUserItem && presentation.item.kind === "user_message" && !options.skipOptimisticUserMessageMatch
        ? matchingOptimisticUserMessage(next.indexes, presentation.item)
        : undefined;
    const confirmedItem =
      exactConfirmedUserItem ??
      (optimisticItem || options.disableEquivalentCompletedItemMatch
        ? undefined
        : matchingConfirmedAppServerItem(next.indexes, presentation.item, {
            allowUntetheredUserMessageMatch: !options.skipOptimisticUserMessageMatch,
          }));
    const pendingItem = pendingTimelineItemById(next.indexes, presentation.item.id);
    const item = confirmedItem
      ? confirmAppServerUserMessage(confirmedItem, presentation.item, event, options)
      : optimisticItem
        ? confirmOptimisticUserMessage(optimisticItem, presentation.item, event, options)
        : pendingItem
          ? mergeTimelineItem(pendingItem, presentation.item, event)
          : presentation.item;
    if (confirmedItem) {
      next.indexes.itemUpdatesById.set(confirmedItem.id, item);
      addToTurn(next, item);
      return createTimelineStateFromDraft(next);
    }
    if (optimisticItem) {
      next.indexes.itemUpdatesById.set(optimisticItem.id, item);
      addToTurn(next, item);
      return createTimelineStateFromDraft(next);
    }
    next.indexes.pendingItemById.delete(presentation.item.id);
    addItem(next, item);
    addToTurn(next, item);
  }
  compactTimelineStores(next.indexes);

  return createTimelineStateFromDraft(next);
}

function mergeTimelineItem(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  const text = mergeTimelineText(existing, incoming, event);
  const output = isCommandOutputDelta(event)
    ? (existing.output ?? "") + incoming.text
    : incoming.output || existing.output;
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
    output,
    path: incoming.path || existing.path,
    messagePhase: incoming.messagePhase || existing.messagePhase,
    images: mergeImages(existing.images, incoming.images),
    skillMentions: mergeSkillMentions(existing, incoming, text),
    payload: event.payload,
    resultSummary: incoming.resultSummary || existing.resultSummary,
    displayOrder: mergeTimelineDisplayOrder(existing),
    timestampMs: existing.timestampMs ?? incoming.timestampMs,
    status: mergeTimelineStatus(existing, incoming, event),
    toolName: incoming.toolName || existing.toolName,
    text,
  };
}

function mergeSkillMentions(
  existing: TimelineItem,
  incoming: TimelineItem,
  text: string,
): TimelineSkillMention[] | undefined {
  if (incoming.kind !== "user_message") {
    return existing.skillMentions;
  }
  if (incoming.skillMentions !== undefined) {
    return incoming.skillMentions;
  }
  if (!existing.clientRequestId || !existing.skillMentions || existing.skillMentions.length === 0) {
    return undefined;
  }
  return skillMentionsMatchText(existing.skillMentions, text) ? existing.skillMentions : undefined;
}

function skillMentionsMatchText(mentions: TimelineSkillMention[], text: string): boolean {
  return mentions.every(
    (mention) =>
      Number.isInteger(mention.start) &&
      Number.isInteger(mention.end) &&
      mention.start >= 0 &&
      mention.end > mention.start &&
      mention.end <= text.length &&
      text.slice(mention.start, mention.end) === `$${mention.name}`,
  );
}

function collabAgentNameMap(indexes: TimelineIndexes): CollabAgentNameMap {
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

function mergeTimelineDisplayOrder(existing: TimelineItem): number {
  return existing.displayOrder;
}

function mergeTimelineText(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): string {
  if (shouldPreserveCompletedTextFromStaleLiveStart(existing, incoming, event)) {
    return existing.text;
  }
  if (!event.codexMethod?.endsWith("/delta")) {
    return incoming.text || existing.text;
  }
  if (!incoming.text) {
    return existing.text;
  }
  if (existing.status === "completed" && existing.text.includes(incoming.text)) {
    return existing.text;
  }
  return existing.text + incoming.text;
}

function shouldPreserveCompletedTextFromStaleLiveStart(
  existing: TimelineItem,
  incoming: TimelineItem,
  event: EventEnvelope,
): boolean {
  return (
    existing.status === "completed" &&
    incoming.displayOrder < existing.displayOrder &&
    event.codexMethod !== "item/completed" &&
    !event.codexMethod?.endsWith("/delta")
  );
}

function mergeTimelineStatus(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope) {
  if (existing.status === "completed" && event.codexMethod !== "item/completed") {
    return existing.status;
  }
  return incoming.status;
}

function matchingOptimisticUserMessage(indexes: TimelineIndexes, incoming: TimelineItem): TimelineItem | undefined {
  return timelineItems(indexes).find(
    (item) =>
      item.source === "optimistic" &&
      item.kind === "user_message" &&
      item.confirmationState !== "failed" &&
      (!item.turnId || !incoming.turnId || item.turnId === incoming.turnId) &&
      item.text === incoming.text &&
      imagesMatch(item.images ?? [], incoming.images ?? []),
  );
}

function matchingConfirmedAppServerItem(
  indexes: TimelineIndexes,
  incoming: TimelineItem,
  options: { allowUntetheredUserMessageMatch: boolean },
): TimelineItem | undefined {
  if (incoming.kind === "user_message") {
    return (
      matchingConfirmedUserMessage(indexes, incoming) ??
      matchingEquivalentCompletedItem(indexes, incoming, options)
    );
  }
  if (incoming.kind === "assistant_message") {
    return matchingEquivalentCompletedItem(indexes, incoming, options);
  }
  return undefined;
}

function matchingConfirmedUserMessage(indexes: TimelineIndexes, incoming: TimelineItem): TimelineItem | undefined {
  return timelineItems(indexes).find(
    (item) =>
      item.kind === "user_message" &&
      (item.serverItemId === incoming.id || (item.source !== "optimistic" && item.id === incoming.id)) &&
      (!item.turnId || !incoming.turnId || item.turnId === incoming.turnId),
  );
}

function matchingEquivalentCompletedItem(
  indexes: TimelineIndexes,
  incoming: TimelineItem,
  options: { allowUntetheredUserMessageMatch: boolean },
): TimelineItem | undefined {
  if (!incoming.turnId || !incoming.text) {
    return undefined;
  }
  for (const item of timelineItems(indexes)) {
    if (
      item.kind === incoming.kind &&
      item.id !== incoming.id &&
      (options.allowUntetheredUserMessageMatch || !isUntetheredUserMessage(item)) &&
      sameEquivalentItemTurn(item, incoming) &&
      equivalentItemStatusMatches(item, incoming) &&
      item.text === incoming.text &&
      imagesCompatibleForEquivalentItem(item, incoming)
    ) {
      return item;
    }
  }
  return undefined;
}

function isUntetheredUserMessage(item: TimelineItem): boolean {
  return item.kind === "user_message" && item.source === "optimistic" && !item.serverItemId && !item.turnId;
}

function equivalentItemStatusMatches(existing: TimelineItem, incoming: TimelineItem): boolean {
  return incoming.kind === "assistant_message" || existing.status === "completed";
}

function sameEquivalentItemTurn(existing: TimelineItem, incoming: TimelineItem): boolean {
  if (existing.kind === "user_message" && !existing.turnId) {
    return true;
  }
  return existing.turnId === incoming.turnId;
}

function imagesCompatibleForEquivalentItem(existing: TimelineItem, incoming: TimelineItem): boolean {
  if (incoming.kind === "user_message" && (incoming.images ?? []).length === 0) {
    return true;
  }
  return imagesMatch(existing.images ?? [], incoming.images ?? []);
}

function matchingCompletedReplayDeltaItem(
  indexes: TimelineIndexes,
  activeTurnId: string | null,
  incoming: TimelineItem,
  event: EventEnvelope,
): TimelineItem | undefined {
  if (!shouldCheckCompletedReplayDelta(activeTurnId, incoming, event)) {
    return undefined;
  }
  for (const item of timelineItems(indexes)) {
    if (shouldIgnoreCompletedReplayDelta(activeTurnId, item, incoming, event)) {
      return item;
    }
  }
  return undefined;
}

function shouldIgnoreCompletedReplayDelta(
  activeTurnId: string | null,
  existing: TimelineItem,
  incoming: TimelineItem,
  event: EventEnvelope,
): boolean {
  return (
    shouldCheckCompletedReplayDelta(activeTurnId, incoming, event) &&
    existing.kind === "assistant_message" &&
    existing.turnId === incoming.turnId &&
    existing.status === "completed" &&
    Boolean(incoming.text) &&
    existing.text.includes(incoming.text)
  );
}

function shouldCheckCompletedReplayDelta(
  activeTurnId: string | null,
  incoming: TimelineItem,
  event: EventEnvelope,
): boolean {
  return (
    event.codexMethod?.endsWith("/delta") === true &&
    incoming.kind === "assistant_message" &&
    Boolean(incoming.turnId) &&
    activeTurnId !== incoming.turnId
  );
}

function appendTimelineDebugEvent(item: TimelineItem, event: EventEnvelope): TimelineItem {
  return {
    ...item,
    debugEvents: [...item.debugEvents, event],
  };
}

function confirmOptimisticUserMessage(
  existing: TimelineItem,
  incoming: TimelineItem,
  event: EventEnvelope,
  options: TimelineEventApplyOptions = {},
): TimelineItem {
  return confirmAppServerUserMessage(existing, incoming, event, options);
}

function confirmAppServerUserMessage(
  existing: TimelineItem,
  incoming: TimelineItem,
  event: EventEnvelope,
  options: TimelineEventApplyOptions = {},
): TimelineItem {
  const merged = mergeTimelineItem(existing, incoming, event);
  return {
    ...merged,
    id: existing.id,
    serverItemId: existing.serverItemId ?? incoming.id,
    source: "app_server",
    confirmationState: "sent",
    error: undefined,
    displayOrder: options.preserveIncomingDisplayOrderOnConfirm ? incoming.displayOrder : merged.displayOrder,
    status: merged.status,
    turnId: incoming.turnId || existing.turnId,
  };
}

function imagesMatch(existing: TimelineImage[], incoming: TimelineImage[]): boolean {
  if (incoming.length === 0) {
    return existing.length === 0;
  }
  if (existing.length !== incoming.length) {
    return false;
  }
  const existingKeys = existing.map(imageKey).sort();
  const incomingKeys = incoming.map(imageKey).sort();
  return existingKeys.every((key, index) => key === incomingKeys[index]);
}

function imageKey(image: TimelineImage): string {
  return image.path || image.url || "";
}

function nextOptimisticDisplayOrder(indexes: TimelineIndexes): number {
  const maxDisplayOrder = timelineItems(indexes).reduce((max, item) => Math.max(max, item.displayOrder), 0);
  return maxDisplayOrder + 0.1;
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
    for (const itemId of existing.itemIds) {
      if (itemId === item.id) {
        return;
      }
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

function upsertTimelineTurn(state: TimelineDraft, event: EventEnvelope) {
  const payload = recordValue(event.payload);
  const turn = recordValue(payload?.turn);
  const turnId = event.turnId ?? stringValue(turn?.id);
  if (!turnId) {
    return;
  }
  upsertTimelineTurnSnapshot(state, {
    turnId,
    status: stringValue(turn?.status),
    startedAtMs: unixSecondsToMs(numberValue(turn?.startedAt)) ?? eventReceivedAtMs(event),
    completedAtMs: unixSecondsToMs(numberValue(turn?.completedAt)) ?? terminalTurnCompletedAtMs(turn, event),
  });
}

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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function unixSecondsToMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value * 1_000 : undefined;
}

function terminalTurnCompletedAtMs(turn: Record<string, unknown> | null, event: EventEnvelope): number | undefined {
  return isTerminalTurnStatusValue(stringValue(turn?.status)) ? eventReceivedAtMs(event) : undefined;
}

function eventReceivedAtMs(event: EventEnvelope): number | undefined {
  const parsed = Date.parse(event.receivedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTerminalTurnStatusValue(status: string | undefined): boolean {
  return ["completed", "failed", "cancelled", "canceled", "interrupted"].includes((status ?? "").toLowerCase());
}
