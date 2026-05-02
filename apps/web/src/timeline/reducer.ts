import type { EventEnvelope } from "../api/client";
import {
  createBaseItem,
  createDiagnosticItem,
  createPresentationItem,
  eventStatus,
  isErrorEvent,
  isLifecycleEvent,
  isWarningEvent,
  mergeImages,
} from "./presentation";
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
  TimelineImage,
  TimelineItem,
  TimelineItemSource,
  TimelineState,
  TimelineStatus,
  TimelineTurn,
  WebSearchAction,
} from "./state";

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

  const existingItem = event.itemId ? timelineItemById(next.indexes, event.itemId) : undefined;
  const presentation = createPresentationItem(event, existingItem);
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
    const confirmedItem =
      presentation.item.kind === "user_message" ? matchingConfirmedUserMessage(next.indexes, presentation.item) : undefined;
    const optimisticItem = confirmedItem
      ? undefined
      : presentation.item.kind === "user_message"
        ? matchingOptimisticUserMessage(next.indexes, presentation.item)
        : undefined;
    const pendingItem = pendingTimelineItemById(next.indexes, presentation.item.id);
    const item = confirmedItem
      ? confirmAppServerUserMessage(confirmedItem, presentation.item, event)
      : optimisticItem
        ? confirmOptimisticUserMessage(optimisticItem, presentation.item, event)
        : pendingItem
          ? mergeTimelineItem(pendingItem, presentation.item, event)
          : presentation.item;
    if (confirmedItem) {
      next.indexes.itemUpdatesById.set(confirmedItem.id, item);
      return createTimelineStateFromDraft(next);
    }
    if (optimisticItem) {
      next.indexes.itemUpdatesById.set(optimisticItem.id, item);
      return createTimelineStateFromDraft(next);
    }
    next.indexes.pendingItemById.delete(presentation.item.id);
    addItem(next, item);
    addToTurn(next, item);
  }
  compactTimelineStores(next.indexes);

  return createTimelineStateFromDraft(next);
}

export function addOptimisticUserMessage(state: TimelineState, input: OptimisticUserMessageInput): TimelineState {
  const next: TimelineDraft = {
    activeTurnId: state.activeTurnId,
    indexes: prepareTimelineIndexesForUpdate(indexesForState(state)),
    lastSeq: state.lastSeq,
  };
  const item: TimelineItem = {
    id: `optimistic-${input.clientRequestId}`,
    kind: "user_message",
    status: input.confirmationState === "failed" ? "failed" : "completed",
    text: input.text,
    turnId: input.turnId,
    seq: nextOptimisticSeq(state, next.indexes),
    payload: { optimistic: true },
    debugEvents: [],
    images: input.images,
    source: "optimistic",
    clientRequestId: input.clientRequestId,
    confirmationState: input.confirmationState,
  };
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
  };
  const item = timelineItems(next.indexes).find(
    (candidate) => candidate.source === "optimistic" && candidate.clientRequestId === clientRequestId,
  );
  if (!item) {
    return state;
  }

  next.indexes.itemIds = next.indexes.itemIds.filter((itemId) => itemId !== item.id);
  next.indexes.itemUpdatesById.delete(item.id);
  next.indexes.pendingItemById.delete(item.id);
  if (item.turnId) {
    const turn = timelineTurnById(next.indexes, item.turnId);
    if (turn) {
      const itemIds = turn.itemIds.filter((itemId) => itemId !== item.id);
      if (itemIds.length > 0) {
        next.indexes.turnUpdatesById.set(item.turnId, { ...turn, itemIds });
      } else {
        next.indexes.turnIds = next.indexes.turnIds.filter((turnId) => turnId !== item.turnId);
        next.indexes.turnUpdatesById.delete(item.turnId);
      }
    }
  }

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

function matchingConfirmedUserMessage(indexes: TimelineIndexes, incoming: TimelineItem): TimelineItem | undefined {
  return timelineItems(indexes).find(
    (item) =>
      item.source === "app_server" &&
      item.kind === "user_message" &&
      item.serverItemId === incoming.id &&
      (!item.turnId || !incoming.turnId || item.turnId === incoming.turnId),
  );
}

function confirmOptimisticUserMessage(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  return confirmAppServerUserMessage(existing, incoming, event);
}

function confirmAppServerUserMessage(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  return {
    ...mergeTimelineItem(existing, incoming, event),
    id: existing.id,
    serverItemId: existing.serverItemId ?? incoming.id,
    source: "app_server",
    confirmationState: "sent",
    error: undefined,
    status: incoming.status,
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

function nextOptimisticSeq(state: TimelineState, indexes: TimelineIndexes): number {
  const maxItemSeq = timelineItems(indexes).reduce((max, item) => Math.max(max, item.seq), state.lastSeq);
  return maxItemSeq + 0.1;
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
