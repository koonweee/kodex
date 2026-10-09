import { useCallback, useEffect, useState } from "react";

import { ACTIVITY_ITEM_RENDER_CHUNK } from "./TimelineActivityGroupRenderer";
import type { TimelineRow } from "./reducer";

export type ActivityPresentationState = {
  expanded: boolean;
  expandedItemIds: ReadonlySet<string>;
  visibleItemCount: number;
};

type TimelineDisclosureState = {
  activityPresentationByRowKey: ReadonlyMap<string, ActivityPresentationState>;
  expandedWorkRowKeys: ReadonlySet<string>;
  threadId?: string;
};

const EMPTY_ACTIVITY_PRESENTATION = new Map<string, ActivityPresentationState>();
const EMPTY_EXPANDED_WORK_ROWS = new Set<string>();

function emptyDisclosureState(threadId?: string): TimelineDisclosureState {
  return {
    activityPresentationByRowKey: EMPTY_ACTIVITY_PRESENTATION,
    expandedWorkRowKeys: EMPTY_EXPANDED_WORK_ROWS,
    threadId,
  };
}

export function useTimelineDisclosureState(rows: TimelineRow[], threadId?: string) {
  const [disclosureState, setDisclosureState] = useState<TimelineDisclosureState>(() => emptyDisclosureState(threadId));
  const currentState = disclosureState.threadId === threadId ? disclosureState : emptyDisclosureState(threadId);

  useEffect(() => {
    const { activityItemIdsByRowKey, expandableWorkRowKeys } = presentationRowKeys(rows);
    setDisclosureState((current) => {
      const matching = current.threadId === threadId ? current : emptyDisclosureState(threadId);
      const activityPresentationByRowKey = pruneActivityPresentation(
        matching.activityPresentationByRowKey,
        activityItemIdsByRowKey,
      );
      const expandedWorkRowKeys = pruneSet(matching.expandedWorkRowKeys, expandableWorkRowKeys);
      if (
        matching === current &&
        activityPresentationByRowKey === current.activityPresentationByRowKey &&
        expandedWorkRowKeys === current.expandedWorkRowKeys
      ) return current;
      return { activityPresentationByRowKey, expandedWorkRowKeys, threadId };
    });
  }, [rows, threadId]);

  const handleWorkRowExpandedChange = useCallback((rowKey: string, expanded: boolean) => {
    setDisclosureState((current) => {
      const matching = current.threadId === threadId ? current : emptyDisclosureState(threadId);
      const expandedWorkRowKeys = updateSet(matching.expandedWorkRowKeys, rowKey, expanded);
      if (matching === current && expandedWorkRowKeys === current.expandedWorkRowKeys) return current;
      return { ...matching, expandedWorkRowKeys };
    });
  }, [threadId]);
  const updateActivityPresentation = useCallback((rowKey: string, update: (current: ActivityPresentationState) => ActivityPresentationState) => {
    setDisclosureState((current) => {
      const matching = current.threadId === threadId ? current : emptyDisclosureState(threadId);
      const previous = matching.activityPresentationByRowKey.get(rowKey) ?? {
        expanded: false,
        expandedItemIds: new Set<string>(),
        visibleItemCount: ACTIVITY_ITEM_RENDER_CHUNK,
      };
      const nextState = update(previous);
      if (nextState === previous) return matching === current ? current : matching;
      const activityPresentationByRowKey = new Map(matching.activityPresentationByRowKey);
      activityPresentationByRowKey.set(rowKey, nextState);
      return { ...matching, activityPresentationByRowKey };
    });
  }, [threadId]);
  const handleActivityExpandedChange = useCallback((rowKey: string, expanded: boolean) => {
    updateActivityPresentation(rowKey, (current) => current.expanded === expanded ? current : { ...current, expanded });
  }, [updateActivityPresentation]);
  const handleActivityItemExpandedChange = useCallback((rowKey: string, itemId: string, expanded: boolean) => {
    updateActivityPresentation(rowKey, (current) => {
      if (current.expandedItemIds.has(itemId) === expanded) return current;
      return { ...current, expandedItemIds: updateSet(current.expandedItemIds, itemId, expanded) };
    });
  }, [updateActivityPresentation]);
  const handleActivityVisibleItemCountChange = useCallback((rowKey: string, visibleItemCount: number) => {
    updateActivityPresentation(rowKey, (current) => current.visibleItemCount === visibleItemCount
      ? current
      : { ...current, visibleItemCount });
  }, [updateActivityPresentation]);

  return {
    activityPresentationByRowKey: currentState.activityPresentationByRowKey,
    expandedWorkRowKeys: currentState.expandedWorkRowKeys,
    handleActivityExpandedChange,
    handleActivityItemExpandedChange,
    handleActivityVisibleItemCountChange,
    handleWorkRowExpandedChange,
  };
}

function presentationRowKeys(rows: TimelineRow[]) {
  const activityItemIdsByRowKey = new Map<string, ReadonlySet<string>>();
  const expandableWorkRowKeys = new Set<string>();
  const visit = (row: TimelineRow) => {
    if (row.type === "activity") activityItemIdsByRowKey.set(row.key, new Set(row.items.map((item) => item.id)));
    if (row.type !== "work") return;
    if (row.collapsedRows.length > 0) expandableWorkRowKeys.add(row.key);
    row.collapsedRows.forEach(visit);
  };
  rows.forEach(visit);
  return { activityItemIdsByRowKey, expandableWorkRowKeys };
}

function pruneSet(current: ReadonlySet<string>, retainedKeys: ReadonlySet<string>) {
  if ([...current].every((key) => retainedKeys.has(key))) return current;
  return new Set([...current].filter((key) => retainedKeys.has(key)));
}

function updateSet(current: ReadonlySet<string>, key: string, included: boolean) {
  if (current.has(key) === included) return current;
  const next = new Set(current);
  if (included) next.add(key);
  else next.delete(key);
  return next;
}

function pruneActivityPresentation(
  current: ReadonlyMap<string, ActivityPresentationState>,
  activityItemIdsByRowKey: ReadonlyMap<string, ReadonlySet<string>>,
) {
  if (current.size === 0) return current;
  let changed = false;
  const next = new Map<string, ActivityPresentationState>();
  for (const [rowKey, state] of current) {
    const itemIds = activityItemIdsByRowKey.get(rowKey);
    if (!itemIds) {
      changed = true;
      continue;
    }
    const expandedItemIds = new Set([...state.expandedItemIds].filter((itemId) => itemIds.has(itemId)));
    if (expandedItemIds.size !== state.expandedItemIds.size) changed = true;
    next.set(rowKey, expandedItemIds.size === state.expandedItemIds.size ? state : { ...state, expandedItemIds });
  }
  return changed ? next : current;
}
