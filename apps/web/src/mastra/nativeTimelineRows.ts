import type { TimelineItem, TimelineRow } from '../timeline/state';

export type NativeItemOrigin = { messageId: string; partIndex: number };
const activityKinds = new Set(['collab_agent_tool_call', 'command_execution', 'dynamic_tool_call', 'mcp_tool_call', 'web_search_group']);
function isActivity(item: TimelineItem) {
  return activityKinds.has(item.kind) && !item.asyncQuestions?.length && item.toolName !== 'ask_user' && item.toolName !== 'submit_plan' && item.toolName !== 'request_user_input_async'
    && item.status !== 'waiting' && item.status !== 'approval_required';
}

/** Group only adjacent parts of an actual assistant message. Native messages
 * provide no turn completion/duration contract, so these rows have no work row.
 */
export function nativeTimelineRows(items: TimelineItem[], origins: Array<NativeItemOrigin | undefined>): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previousOrigin: NativeItemOrigin | undefined;
  for (const [index, item] of items.entries()) {
    const origin = origins[index];
    const previous = rows.at(-1);
    if (origin && isActivity(item)) {
      if (previous?.type === 'activity' && previousOrigin?.messageId === origin.messageId && previousOrigin.partIndex + 1 === origin.partIndex) {
        previous.items.push(item);
      } else {
        const key = JSON.stringify(['native-activity', origin.messageId, item.id]);
        rows.push({ type: 'activity', key, turnKey: key, turnId: null, displayOrder: item.displayOrder, items: [item] });
      }
    } else rows.push({ type: 'item', key: item.id, turnKey: item.id, turnId: null, displayOrder: item.displayOrder, item });
    previousOrigin = origin;
  }
  return rows;
}
