import { applyTimelineEvent } from "./reducer";

type TimelineEventEnvelope = Parameters<typeof applyTimelineEvent>[1];

function event(overrides: Partial<TimelineEventEnvelope>): TimelineEventEnvelope {
  const base: TimelineEventEnvelope = {
    id: "event-1",
    seq: 1,
    kind: "codex.notification",
    codexMethod: "item/started",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    projectId: "project-1",
    payload: {},
    receivedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
  if (overrides.kind || !payloadHasItem(base.payload)) {
    return base;
  }
  const snapshotItemId = presentationFixtureItemId(base);
  const itemType = fixtureItemType(base.payload);
  const status = fixtureStatus(base);
  return {
    ...base,
    kind: "thread_view.patch",
    payload: {
      threadId: base.threadId ?? "thread-1",
      viewRevision: base.seq,
      liveState: "running",
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      turns: [],
      items: [
        {
          id: snapshotItemId,
          threadId: base.threadId ?? "thread-1",
          turnId: base.turnId ?? "turn-1",
          itemId: base.itemId ?? base.id,
          itemType,
          status,
          displayOrder: base.seq,
          codexMethod: base.codexMethod ?? "item/upsert",
          timestampMs: Date.parse(base.receivedAt),
          payload: {
            source: "gateway_stream",
            turnId: base.turnId ?? "turn-1",
            itemId: base.itemId ?? base.id,
            item: payloadItem(base.payload),
            itemSnapshot: {
              id: base.itemId ?? base.id,
              itemType,
              rawPayload: payloadItem(base.payload),
            },
          },
        },
      ],
    },
  };
}

function payloadHasItem(payload: unknown): boolean {
  return Boolean(payloadRecord(payload)?.item);
}

function payloadItem(payload: unknown): unknown {
  return payloadRecord(payload)?.item ?? {};
}

function fixtureItemType(payload: unknown): string {
  const item = payloadRecord(payloadItem(payload));
  return typeof item?.type === "string" ? item.type : "unknown";
}

function presentationFixtureItemId(event: TimelineEventEnvelope): string {
  const item = payloadRecord(payloadItem(event.payload));
  const itemId = typeof item?.id === "string" ? item.id : (event.itemId ?? event.id);
  const itemType = typeof item?.type === "string" ? item.type.toLowerCase() : "";
  if (itemType === "websearch" && item && isInformativeWebSearch(item)) {
    return `web-search-${event.turnId ?? event.itemId ?? event.id}`;
  }
  return itemId;
}

function fixtureStatus(event: TimelineEventEnvelope): string {
  const item = payloadRecord(payloadItem(event.payload));
  const itemStatus = typeof item?.status === "string" ? item.status : "";
  const phase = typeof item?.phase === "string" ? item.phase : "";
  if (itemStatus || phase) {
    return itemStatus || phase;
  }
  return event.codexMethod === "item/completed" ? "completed" : "running";
}

function isInformativeWebSearch(item: Record<string, unknown>): boolean {
  if (typeof item.query === "string" && item.query.trim()) {
    return true;
  }
  const action = payloadRecord(item.action);
  const actionType = typeof action?.type === "string" ? action.type.toLowerCase() : "";
  if (actionType === "search") {
    return typeof action?.query === "string" && action.query.trim().length > 0;
  }
  if (actionType === "open" || actionType === "openpage") {
    return typeof action?.url === "string" && action.url.trim().length > 0;
  }
  return false;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

export { applyTimelineEvent, event };
