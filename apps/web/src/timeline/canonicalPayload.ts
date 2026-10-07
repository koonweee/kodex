import type {
  EventEnvelope,
  ThreadTimelineRow,
  ThreadTimelineSnapshotItem,
  ThreadTimelineWorkDetailRow,
} from "../api/client";
import { unixSecondsToMs } from "../shared/values";
import { compactStoredTimelineEvent, createTimelineIndexBuilder } from "./indexBuilder";
import { createDiagnosticItem, createPresentationItem, type TimelinePresentationItem } from "./presentation";
import type { TimelineItem, TimelineRow } from "./state";

export function canonicalTimelineRowsToViewRows(
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
      collapsedRows: (row.collapsedRows ?? [])
        .map((collapsedRow) => canonicalTimelineRowToViewRow(threadId, collapsedRow, builder, hiddenItems))
        .filter((collapsedRow): collapsedRow is Exclude<TimelineRow, { type: "work" }> => collapsedRow !== null && collapsedRow.type !== "work"),
      displayOrder: row.displayOrder,
    };
  }

  if (row.kind === "activity") {
    const items = (row.items ?? [])
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
    const diagnostic = createDiagnosticItem(event);
    // Empty bodies are compact identity markers retained for canonical patch bases.
    // They have no received debug content to display when the toggle is enabled.
    hiddenItems.push(Object.keys(item.payload.item).length === 0
      ? { ...diagnostic, debugEvents: [], text: "" }
      : diagnostic);
    return null;
  }
  const nextItem = canonicalPresentationItem(presentation, item).item;
  builder.addItem(nextItem);
  return nextItem;
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
    payload: {
      ...item.payload,
      item: {
        ...item.payload.item,
        id: item.itemId,
        type: item.itemType,
        status: item.payload.item.status ?? item.status,
      },
    },
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
      clientId: item.payload.clientId ?? undefined,
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
