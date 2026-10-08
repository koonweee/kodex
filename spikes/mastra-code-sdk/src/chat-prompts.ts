import { ORPCError } from '@orpc/server';
import { captureChatFastRequestContext } from './chat-fast.js';
import type { NativeSession } from './runtime.js';

export interface NativePromptTarget {
  sessionId: string;
  threadId: string;
  resourceId: string;
  runId: string;
  toolCallId: string;
}
export type NativePrompt =
  | { kind: 'question'; target: NativePromptTarget; question: string; options?: Array<{ label: string; description?: string }>; selectionMode?: 'single_select' | 'multi_select' }
  | { kind: 'approval'; target: NativePromptTarget; toolName: string; args: unknown }
  | { kind: 'plan'; target: NativePromptTarget; path: string; title?: string; plan?: string }
  | { kind: 'unsupported'; target: NativePromptTarget | null; toolCallId: string; toolName: string; reason: string };
export type PromptResponse = { target: NativePromptTarget } & (
  | { kind: 'question'; answer: string | string[] }
  | { kind: 'approval'; decision: 'approve' | 'decline' | 'always_allow_category' }
  | { kind: 'plan'; action: 'approved' | 'rejected'; feedback?: string }
);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const conflict = () => new ORPCError('CONFLICT', { message: 'This native prompt is no longer pending on the expected session and run.' });
const invalid = (message: string) => new ORPCError('BAD_REQUEST', { message });
function target(session: NativeSession, toolCallId: string, runId: string, threadId: string, resourceId: string): NativePromptTarget {
  return { sessionId: session.identity.getId(), threadId, resourceId, runId, toolCallId };
}

/** Read the mounted native gates only. Detached and unfamiliar waits stay visible. */
export function readNativePrompts(session: NativeSession): NativePrompt[] {
  const result: NativePrompt[] = [], display = session.displayState.get();
  const threadId = session.thread.getId(), resourceId = session.identity.getResourceId();
  const unsupported = (toolCallId: string, toolName: string, reason: string, binding: NativePromptTarget | null = null): NativePrompt =>
    ({ kind: 'unsupported', target: binding, toolCallId, toolName, reason });
  for (const pending of display.pendingSuspensions.values()) {
    const parked = session.suspensions.get({ toolCallId: pending.toolCallId });
    if (!parked || !threadId || parked.threadId !== threadId || parked.resourceId !== resourceId || !parked.runId) {
      result.push(unsupported(pending.toolCallId, pending.toolName, 'Native suspension is not bound to this current session thread.')); continue;
    }
    const binding = target(session, pending.toolCallId, parked.runId, threadId, resourceId);
    const payload = record(pending.suspendPayload);
    if (pending.toolName !== parked.toolName) {
      result.push(unsupported(pending.toolCallId, pending.toolName, 'Native suspension binding and display disagree.', binding)); continue;
    }
    if (pending.toolName === 'ask_user' && payload && typeof payload.question === 'string'
      && (payload.selectionMode === undefined || payload.selectionMode === 'single_select' || payload.selectionMode === 'multi_select')
      && (payload.options === undefined || (Array.isArray(payload.options) && payload.options.every(option => {
        const entry = record(option); return entry && typeof entry.label === 'string' && (entry.description === undefined || typeof entry.description === 'string');
      })))) {
      const options = payload.options as Array<{ label: string; description?: string }> | undefined;
      if (payload.selectionMode && !options?.length) {
        result.push(unsupported(pending.toolCallId, pending.toolName, 'Native selection prompt has no options.', binding)); continue;
      }
      result.push({ kind: 'question', target: binding, question: payload.question,
        ...(options && { options: options.map(option => ({ label: option.label, ...(option.description !== undefined && { description: option.description }) })) }),
        ...(payload.selectionMode !== undefined && { selectionMode: payload.selectionMode }) });
    } else if (pending.toolName === 'submit_plan' && payload && typeof payload.path === 'string'
      && (payload.title === undefined || typeof payload.title === 'string') && (payload.plan === undefined || typeof payload.plan === 'string')) {
      result.push({ kind: 'plan', target: binding, path: payload.path,
        ...(payload.title !== undefined && { title: payload.title }), ...(payload.plan !== undefined && { plan: payload.plan }) });
    } else result.push(unsupported(pending.toolCallId, pending.toolName, 'This native suspended tool or payload is not supported yet.', binding));
  }
  const runId = session.run.getRunId();
  for (const pending of display.pendingApprovals.values()) {
    if (!threadId || !runId || pending.threadId !== threadId
      || !session.approval.isArmed({ toolCallId: pending.toolCallId, threadId, runId })) {
      result.push(unsupported(pending.toolCallId, pending.toolName, 'Native approval belongs to a detached or unavailable run.')); continue;
    }
    result.push({ kind: 'approval', target: target(session, pending.toolCallId, runId, threadId, resourceId),
      toolName: pending.toolName, args: structuredClone(pending.args) });
  }
  return result;
}

/** Validate and claim after context awaits; starting the response shares that tick. */
export async function respondNativePrompt(session: NativeSession, input: PromptResponse): Promise<{ accepted: true }> {
  const submitted = record(input), expected = record(submitted?.target);
  if (!submitted || !expected || !['sessionId', 'threadId', 'resourceId', 'runId', 'toolCallId'].every(key => typeof expected[key] === 'string' && expected[key])) {
    throw invalid('Provide the exact native prompt target.');
  }
  const requestContext = await captureChatFastRequestContext(session);
  const prompt = readNativePrompts(session).find(prompt => prompt.target
    && Object.entries(prompt.target).every(([key, value]) => expected[key] === value));
  if (!prompt || session.run.isAbortRequested()) throw conflict();
  if (prompt.kind === 'unsupported') throw invalid(prompt.reason);
  if (submitted.kind !== prompt.kind) throw invalid('Response kind does not match the pending native prompt.');
  let resumeData: unknown;
  if (prompt.kind === 'question') {
    const answer = submitted.answer;
    if (prompt.selectionMode === 'multi_select'
      ? !Array.isArray(answer) || !answer.every(value => typeof value === 'string')
      : typeof answer !== 'string') throw invalid('Provide a string answer, or a string array for native multi-select.');
    resumeData = answer;
  } else if (prompt.kind === 'plan') {
    if ((submitted.action !== 'approved' && submitted.action !== 'rejected')
      || (submitted.feedback !== undefined && typeof submitted.feedback !== 'string')) throw invalid('Provide a native plan decision and optional text feedback.');
    resumeData = { action: submitted.action, ...(submitted.feedback !== undefined && { feedback: submitted.feedback }), path: prompt.path,
      ...(prompt.title !== undefined && { title: prompt.title }), ...(prompt.plan !== undefined && { plan: prompt.plan }) };
  } else if (submitted.decision !== 'approve' && submitted.decision !== 'decline' && submitted.decision !== 'always_allow_category') throw invalid('Provide a native approval decision.');

  const toolCallId = prompt.target.toolCallId;
  if (prompt.kind === 'approval') {
    if (!session.claimToolResponse(toolCallId)) throw conflict();
    try {
      const admitted = session.respondToToolApproval({ toolCallId,
        decision: submitted.decision as 'approve' | 'decline' | 'always_allow_category', requestContext });
      if (!admitted.accepted) throw conflict();
    } finally { session.releaseToolResponse(toolCallId); }
  } else {
    if (!session.claimToolSuspension(toolCallId).accepted) throw conflict();
    // Native resume publishes its error/end events; callers acknowledge admission.
    void session.respondToToolSuspension({ toolCallId, resumeData, requestContext })
      .finally(() => session.releaseToolResponse(toolCallId)).catch(() => {});
  }
  return { accepted: true };
}
