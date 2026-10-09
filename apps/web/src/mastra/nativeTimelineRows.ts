import type { TimelineItem, TimelineRow } from '../timeline/state';

export type NativeItemOrigin = { messageId: string; groupingIndex: number };
const activityKinds = new Set(['reasoning', 'collab_agent_tool_call', 'command_execution', 'dynamic_tool_call', 'mcp_tool_call', 'web_search_group']);
function isInteractive(item: TimelineItem) {
  return Boolean(item.asyncQuestions?.length) || item.toolName === 'ask_user' || item.toolName === 'submit_plan' || item.toolName === 'request_user_input_async'
    || item.status === 'waiting' || item.status === 'approval_required';
}
function isActivity(item: TimelineItem) {
  return !isInteractive(item) && (activityKinds.has(item.kind) || item.kind === 'file_change' && item.fileChangeOutcomeKnown === false);
}

function adjacent(left: NativeItemOrigin | undefined, right: NativeItemOrigin | undefined) {
  return left !== undefined && right !== undefined && left.messageId === right.messageId && left.groupingIndex + 1 === right.groupingIndex;
}

/** Fold native message-local activity, not inferred turns or final answers. */
export function nativeTimelineRows(items: TimelineItem[], origins: Array<NativeItemOrigin | undefined>): TimelineRow[] {
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
      if (followingTool) progress.add(index);
    } else followingTool = false;
  }

  const rows: TimelineRow[] = [];
  let previousOrigin: NativeItemOrigin | undefined;
  for (const [index, item] of items.entries()) {
    const origin = origins[index];
    const previous = rows.at(-1);
    if (origin && (isActivity(item) || progress.has(index))) {
      if (previous?.type === 'activity' && adjacent(previousOrigin, origin)) {
        previous.items.push(item);
      } else {
        const key = JSON.stringify(['native-activity', origin.messageId, item.id]);
        rows.push({ type: 'activity', key, turnKey: key, turnId: null, displayOrder: item.displayOrder, items: [item], fallbackSummary: 'Activity' });
      }
    } else if (!origin && item.kind === 'file_change' && isActivity(item)) {
      const key = JSON.stringify(['native-file-activity', item.id]);
      rows.push({ type: 'activity', key, turnKey: key, turnId: null, displayOrder: item.displayOrder, items: [item], fallbackSummary: 'Activity' });
    } else rows.push({ type: 'item', key: item.id, turnKey: item.id, turnId: null, displayOrder: item.displayOrder, item });
    previousOrigin = origin;
  }
  return rows;
}
