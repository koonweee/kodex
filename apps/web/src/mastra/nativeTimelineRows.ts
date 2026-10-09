import type { TimelineItem, TimelineRow } from '../timeline/state';

export type NativeItemOrigin = { messageId: string; groupingIndex: number; workBoundary?: number };
const activityKinds = new Set(['reasoning', 'collab_agent_tool_call', 'command_execution', 'dynamic_tool_call', 'mcp_tool_call', 'web_search_group']);
function isInteractive(item: TimelineItem) {
  return Boolean(item.asyncQuestions?.length) || item.toolName === 'ask_user' || item.toolName === 'submit_plan' || item.toolName === 'request_user_input_async'
    || item.status === 'waiting' || item.status === 'approval_required';
}
function isActivity(item: TimelineItem) {
  return !isInteractive(item) && (activityKinds.has(item.kind) || item.kind === 'file_change' && item.fileChangeOutcomeKnown === false);
}

function adjacent(left: NativeItemOrigin | null | undefined, right: NativeItemOrigin | null | undefined) {
  return left != null && right != null && left.messageId === right.messageId && left.groupingIndex + 1 === right.groupingIndex;
}

/** Fold native message-local activity, not inferred turns or final answers.
 * A null origin is user-authored; undefined is an unassociated live overlay.
 */
export function nativeTimelineRows(items: TimelineItem[], origins: Array<NativeItemOrigin | null | undefined>, visibleCommentary: ReadonlySet<string> = new Set()): TimelineRow[] {
  const progress = new Set<number>();
  let followingTool = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!adjacent(origins[index], origins[index + 1])) followingTool = false;
    const item = items[index];
    if (!origins[index]) followingTool = false;
    else if (isActivity(item)) {
      if (item.kind !== 'reasoning') followingTool = true;
    } else if (item.kind === 'assistant_message' && item.status !== 'failed' && !isInteractive(item)) {
      // Pre-tool text is progress presentation only; trailing text stays visible.
      if (followingTool && !visibleCommentary.has(origins[index]!.messageId)) progress.add(index);
    } else followingTool = false;
  }

  const rows: TimelineRow[] = [];
  let previousOrigin: NativeItemOrigin | null | undefined;
  for (const [index, item] of items.entries()) {
    const origin = origins[index];
    const previous = rows.at(-1);
    if (origin && (isActivity(item) || progress.has(index))) {
      if (previous?.type === 'activity' && adjacent(previousOrigin, origin)) {
        previous.items.push(item);
      } else {
        const key = JSON.stringify(['native-activity', origin.messageId, item.id]);
        rows.push({ type: 'activity', key, turnKey: key, turnId: null, displayOrder: item.displayOrder, items: [item], fallbackSummary: 'Activity', nativeWorkBoundary: origin.workBoundary });
      }
    } else if (origin === undefined && isActivity(item)) {
      const key = JSON.stringify(['native-live-activity', item.id]);
      rows.push({ type: 'activity', key, turnKey: key, turnId: null, displayOrder: item.displayOrder, items: [item], fallbackSummary: 'Activity' });
    } else rows.push({ type: 'item', key: item.id, turnKey: item.id, turnId: null, displayOrder: item.displayOrder, item, nativeWorkBoundary: origin?.workBoundary });
    previousOrigin = origin;
  }
  // Saved identities never change if a later message reuses a tool ID. Only
  // the latest occurrence may adopt the matching unassociated live choice.
  const latest = new Map(items.map((item, index) => [item.id, index]));
  const identities = new Map(items.map((item, index) => {
    const origin = origins[index];
    const liveKey = JSON.stringify(['live-item', item.id]);
    return [item, origin ? { key: JSON.stringify(['message-item', origin.messageId, item.id]),
      ...(latest.get(item.id) === index && { liveKey }) } : { key: liveKey }];
  }));
  for (const row of rows) if (row.type === 'activity') row.disclosureKeys = row.items.map(item => identities.get(item)!);
  return rows;
}
