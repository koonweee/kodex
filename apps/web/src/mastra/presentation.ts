import type { Chat, ChatSnapshot } from './client';
import { nativeImageFields, nativeInputImages } from './nativeImages';
import { nativeFileFields } from './nativeFiles';
import { nativeInputFiles, nativeInputFileText } from './nativeInputFiles';
import { nativeInputSkillFields } from './nativeInputSkills';
import { nativeQuestionFields, nativeQuestionReplyClientId } from './nativeQuestions';
import type { TimelineItem } from '../timeline/state';
import { nativeTimelineRows, type NativeItemOrigin } from './nativeTimelineRows';
import type { TimelinePresentation } from '../timeline/TimelineView';
import type { ThreadListEntry } from '../threads/viewTypes';

export function acceptsSnapshot(current: { epoch: string; revision: number } | null, next: { epoch: string; revision: number }): boolean {
  return current === null || current.epoch !== next.epoch || next.revision > current.revision;
}
export function chatListEntry(chat: Chat): ThreadListEntry { return { id: chat.id, name: chat.title, projectId: chat.projectId, pinned: chat.pinned, isRunning: chat.isRunning }; }
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
function nativeCommandFields(name: string, args: unknown) {
  if (name !== 'execute_command' || typeof args !== 'object' || args === null || !('command' in args) || typeof args.command !== 'string') return null;
  // Native command failures may be successful tool results containing text.
  // Preserve that output without interpreting prose as a structured exit status.
  return { kind: 'command_execution', command: args.command, commandOutcomeKnown: false };
}
function nativeToolFields(name: string, args: unknown, result: unknown, failed: boolean) {
  return nativeImageFields(name, args, result, failed) ?? nativeFileFields(name, args) ?? nativeCommandFields(name, args);
}
type PresentationSnapshot = Pick<ChatSnapshot, 'messages' | 'history' | 'revision'> & {
  display?: Pick<ChatSnapshot['display'], 'currentMessage' | 'isRunning' | 'activeTools'>;
  prompts?: ChatSnapshot['prompts'];
};
export function timelinePresentation(snapshot: PresentationSnapshot, isLoadingOlderHistory = false): TimelinePresentation {
  const current = snapshot.display?.currentMessage;
  const messages = snapshot.messages.map(message => message.id === current?.id ? current : message);
  if (current && !messages.some(message => message.id === current.id)) messages.push(current);
  const items: TimelineItem[] = [];
  const origins: Array<NativeItemOrigin | undefined> = [];
  const toolIndexes = new Map<string, number>();
  const savedToolArgs = new Map<string, { name: string; args: unknown; result: unknown; failed: boolean; completed: boolean; messageId?: string }>();
  function append(item: Omit<TimelineItem, 'displayOrder' | 'turnId' | 'debugEvents'>, origin?: NativeItemOrigin) {
    items.push({ ...item, displayOrder: items.length, turnId: null, debugEvents: [] });
    origins.push(origin);
  }
  for (const message of messages) {
    // Native sessions persist human inputs and steers as user-authored signals.
    const signal = message.content.metadata?.signal;
    const userAuthored = message.role === 'user' || (message.role === 'signal' && typeof signal === 'object' && signal !== null && 'type' in signal && (signal.type === 'user' || signal.type === 'user-message'));
    if (!userAuthored && message.role !== 'assistant') continue;
    const status = current?.id === message.id && snapshot.display?.isRunning ? 'running' : 'completed';
    const images = userAuthored ? nativeInputImages(message.content.parts) : [];
    const files = userAuthored ? nativeInputFiles(message.content.metadata) : [];
    const skillFields = userAuthored ? nativeInputSkillFields(message.content.metadata) : null;
    const attachmentFields = { ...(images.length && { images }), ...(files.length && { fileAttachments: files }) };
    const firstText = message.content.parts.findIndex(part => part.type === 'text');
    if ((images.length || files.length) && firstText === -1) append({ id: `${message.id}:${images.length ? 'images' : 'attachments'}`, kind: 'user_message', text: '', ...attachmentFields, status, payload: message.content.parts, timestampMs: new Date(message.createdAt).getTime(), clientId: nativeQuestionReplyClientId(message.content.metadata) });
    message.content.parts.forEach((part, index) => {
      const origin = message.role === 'assistant' ? { messageId: message.id, partIndex: index } : undefined;
      const id = `${message.id}:${index}`;
      const timestampMs = new Date(message.createdAt).getTime();
      if (part.type === 'text') append({ id, kind: userAuthored ? 'user_message' : 'assistant_message', text: userAuthored && index === firstText ? skillFields?.text ?? nativeInputFileText(part.text, files) : part.text, status, payload: part, timestampMs, ...(userAuthored && { clientId: nativeQuestionReplyClientId(message.content.metadata), ...(index === firstText && { ...attachmentFields, ...(skillFields && { skillMentions: skillFields.skillMentions }) }) }) }, origin);
      else if (part.type === 'reasoning') append({ id, kind: 'reasoning', text: part.reasoning, status, payload: part, timestampMs }, origin);
      else if (part.type === 'tool-invocation') {
        const tool = part.toolInvocation;
        toolIndexes.set(tool.toolCallId, items.length);
        const failed = Boolean(tool.isError || tool.state === 'output-error' || tool.state === 'output-denied');
        const completed = tool.state === 'result';
        const messageId = message.role === 'assistant' ? message.id : undefined;
        savedToolArgs.set(tool.toolCallId, { name: tool.toolName, args: tool.args, result: tool.result, failed, completed, messageId });
        const output = toolResultText(tool.result !== undefined ? tool.result : tool.errorText);
        append({ id: tool.toolCallId, kind: 'dynamic_tool_call', text: '', status: tool.isError || tool.state === 'output-error' || tool.state === 'output-denied' ? 'failed' : tool.state === 'result' ? 'completed' : tool.state === 'approval-requested' ? 'approval_required' : 'running', toolName: tool.toolName, argsSummary: printable(tool.args), output, resultSummary: output, payload: part, timestampMs, ...(nativeQuestionFields(tool.toolName, tool.args, tool.result, failed, completed, messageId, tool.toolCallId) ?? nativeToolFields(tool.toolName, tool.args, tool.result, failed)) }, origin);
      } else if (part.type === 'error') append({ id, kind: 'assistant_message', text: part.error.message, status: 'failed', payload: part, timestampMs }, origin);
    });
  }
  for (const [id, tool] of snapshot.display?.activeTools ?? []) {
    const existing = toolIndexes.get(id);
    const previous = existing === undefined ? undefined : items[existing];
    const saved = savedToolArgs.get(id);
    const args = tool.args === undefined && saved?.name === tool.name ? saved.args : tool.args;
    const file = nativeFileFields(tool.name, args);
    const sameSavedCall = saved?.name === tool.name;
    const retainedQuestion = sameSavedCall && tool.result === undefined && tool.partialResult === undefined
      ? nativeQuestionFields(tool.name, args, saved.result, saved.failed, saved.completed, saved.messageId, id) : null;
    const retainQuestion = retainedQuestion !== null && JSON.stringify(retainedQuestion.asyncQuestions) === JSON.stringify(previous?.asyncQuestions);
    const question = nativeQuestionFields(tool.name, args, retainQuestion ? saved!.result : tool.result,
      Boolean(tool.isError || tool.status === 'error' || retainQuestion && saved!.failed),
      tool.status === 'completed' || Boolean(retainQuestion && saved!.completed), sameSavedCall ? saved.messageId : undefined, id);
    // Streamed shell text omits native terminal annotations (for example exit
    // codes). Once available, the final native result owns the visible output.
    const output = tool.result !== undefined ? toolResultText(tool.result) : tool.shellOutput ?? (tool.partialResult !== undefined ? toolResultText(tool.partialResult) : previous?.toolName === tool.name ? previous.output ?? '' : '');
    const image = tool.name === 'view' && tool.result === undefined && tool.partialResult === undefined && !tool.isError && tool.status !== 'error' && previous?.kind === 'image_view' && (tool.args === undefined || file?.path === previous.path)
      ? { kind: previous.kind, path: previous.path, imageSrc: previous.imageSrc, resultSummary: undefined }
      : nativeImageFields(tool.name, args, tool.result, Boolean(tool.isError || tool.status === 'error'));
    const item = { id, kind: 'dynamic_tool_call', text: '', asyncQuestions: undefined, serverItemId: undefined, status: tool.isError || tool.status === 'error' ? 'failed' as const : tool.status === 'completed' ? 'completed' as const : 'running' as const, toolName: tool.name, argsSummary: printable(args), output, resultSummary: output, payload: tool, imageSrc: undefined, path: undefined, action: undefined, fileChangeOutcomeKnown: undefined, command: undefined, commandOutcomeKnown: undefined, ...(question ?? image ?? file ?? nativeCommandFields(tool.name, args)) };
    if (existing === undefined) { toolIndexes.set(id, items.length); append(item); }
    else items[existing] = { ...items[existing], ...item };
  }
  // Native suspension can mark a tool errored while keeping a live response gate.
  // Only the matching authoritative mounted prompt supersedes that presentation.
  for (const prompt of snapshot.prompts ?? []) {
    if (prompt.kind === 'unsupported') continue;
    const name = prompt.kind === 'plan' ? 'submit_plan' : prompt.kind === 'question' ? 'ask_user' : prompt.toolName;
    const index = toolIndexes.get(prompt.target.toolCallId);
    if (index !== undefined && items[index].toolName === name) items[index] = { ...items[index], status: prompt.kind === 'question' ? 'waiting' : 'approval_required' };
  }
  const rows = nativeTimelineRows(items, origins);
  return { rows, hiddenItems: [], hasOlderHistory: snapshot.history.hasOlder, isLoadingOlderHistory, lastSeq: snapshot.revision, pendingApprovalRequests: [], pendingUserInputRequests: [] };
}
