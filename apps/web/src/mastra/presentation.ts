import type { Chat, ChatSnapshot } from './client';
import type { TimelineItem, TimelineRow } from '../timeline/state';
import type { TimelinePresentation } from '../timeline/TimelineView';
import type { ThreadListEntry } from '../threads/viewTypes';

export function acceptsSnapshot(current: { epoch: string; revision: number } | null, next: { epoch: string; revision: number }): boolean {
  return current === null || current.epoch !== next.epoch || next.revision > current.revision;
}
export function chatListEntry(chat: Chat): ThreadListEntry { return { id: chat.id, name: chat.title, projectId: chat.projectId, pinned: chat.pinned }; }
function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function toolResultText(value: unknown): string {
  // Native media results carry base64 separately from their human-readable text.
  // Generic tool rows must not turn that binary payload into visible prose.
  if (typeof value === 'object' && value !== null && '__workspaceMedia' in value && value.__workspaceMedia === true && 'text' in value && typeof value.text === 'string') return value.text;
  return printable(value);
}
export function timelinePresentation(snapshot: ChatSnapshot, isLoadingOlderHistory = false): TimelinePresentation {
  const current = snapshot.display.currentMessage;
  const messages = snapshot.messages.map(message => message.id === current?.id ? current : message);
  if (current && !messages.some(message => message.id === current.id)) messages.push(current);
  const items: TimelineItem[] = [];
  const toolIndexes = new Map<string, number>();
  function append(item: Omit<TimelineItem, 'displayOrder' | 'turnId' | 'debugEvents'>) {
    items.push({ ...item, displayOrder: items.length, turnId: null, debugEvents: [] });
  }
  for (const message of messages) {
    // Native sessions persist human inputs and steers as user-authored signals.
    const signal = message.content.metadata?.signal;
    const userAuthored = message.role === 'user' || (message.role === 'signal' && typeof signal === 'object' && signal !== null && 'type' in signal && (signal.type === 'user' || signal.type === 'user-message'));
    if (!userAuthored && message.role !== 'assistant') continue;
    const status = current?.id === message.id && snapshot.display.isRunning ? 'running' : 'completed';
    message.content.parts.forEach((part, index) => {
      const id = `${message.id}:${index}`;
      const timestampMs = new Date(message.createdAt).getTime();
      if (part.type === 'text') append({ id, kind: userAuthored ? 'user_message' : 'assistant_message', text: part.text, status, payload: part, timestampMs });
      else if (part.type === 'reasoning') append({ id, kind: 'reasoning', text: part.reasoning, status, payload: part, timestampMs });
      else if (part.type === 'tool-invocation') {
        const tool = part.toolInvocation;
        toolIndexes.set(tool.toolCallId, items.length);
        const output = toolResultText(tool.result !== undefined ? tool.result : tool.errorText);
        append({ id: tool.toolCallId, kind: 'dynamic_tool_call', text: '', status: tool.isError || tool.state === 'output-error' || tool.state === 'output-denied' ? 'failed' : tool.state === 'result' ? 'completed' : tool.state === 'approval-requested' ? 'approval_required' : 'running', toolName: tool.toolName, argsSummary: printable(tool.args), output, resultSummary: output, payload: part, timestampMs });
      } else if (part.type === 'error') append({ id, kind: 'assistant_message', text: part.error.message, status: 'failed', payload: part, timestampMs });
    });
  }
  for (const [id, tool] of snapshot.display.activeTools) {
    const existing = toolIndexes.get(id);
    // Streamed shell text omits native terminal annotations (for example exit
    // codes). Once available, the final native result owns the visible output.
    const output = tool.result !== undefined ? toolResultText(tool.result) : tool.shellOutput ?? (tool.partialResult !== undefined ? toolResultText(tool.partialResult) : existing === undefined ? '' : items[existing].output ?? '');
    const item = { id, kind: 'dynamic_tool_call', text: '', status: tool.isError || tool.status === 'error' ? 'failed' as const : tool.status === 'completed' ? 'completed' as const : 'running' as const, toolName: tool.name, argsSummary: printable(tool.args), output, resultSummary: output, payload: tool };
    if (existing === undefined) append(item);
    else items[existing] = { ...items[existing], ...item };
  }
  const rows: TimelineRow[] = items.map(item => ({ type: 'item', key: item.id, turnKey: item.id, turnId: null, displayOrder: item.displayOrder, item }));
  return { rows, hiddenItems: [], hasOlderHistory: snapshot.history.hasOlder, isLoadingOlderHistory, lastSeq: snapshot.revision, pendingApprovalRequests: [], pendingUserInputRequests: [] };
}
