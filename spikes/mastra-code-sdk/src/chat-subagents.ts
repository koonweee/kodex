import { randomUUID } from 'node:crypto';
import { EventPublisher, ORPCError } from '@orpc/server';
import type { ActiveSubagentState } from '@mastra/core/agent-controller';
import { ownsThread, type NativeThread } from './chat-projects.js';
import { readChatHistory, type ChatHistory, type HistoryBoundary, type HistoryRequest, type NativeHistoryMessage } from './chat-history.js';
import type { RuntimeBinding } from './product-registry.js';
import type { NativeSession, ProjectRuntime } from './runtime.js';

export interface SubagentInvocation {
  id: string;
  agentType: string | null;
  task: string | null;
  modelId: string | null;
  forked: boolean;
  status: 'running' | 'completed' | 'error' | 'unknown';
  result: string | null;
  /** Canonical native activity only while the parent is already mounted. */
  activity: ActiveSubagentState | null;
}
export interface SubagentList {
  epoch: string;
  revision: number;
  chatId: string;
  invocations: SubagentInvocation[];
  /** Native fork metadata has no tool-call ID; these remain separate identities. */
  forks: Array<{ id: string; title: string }>;
  history: HistoryBoundary;
}
export interface SubagentSelection { chatId: string; kind: 'invocation' | 'fork'; id: string; history?: HistoryRequest }
export interface SubagentSnapshot {
  epoch: string;
  revision: number;
  chatId: string;
  kind: SubagentSelection['kind'];
  id: string;
  invocation: SubagentInvocation | null;
  messages: NativeHistoryMessage[];
  history: HistoryBoundary;
}
interface Parent {
  binding: RuntimeBinding;
  runtime: ProjectRuntime;
  thread: NativeThread;
  session?: NativeSession;
}
const missing = () => new ORPCError('NOT_FOUND', { message: 'Subagent or parent chat not found.' });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : null;
const isChild = (parent: Parent, child: NativeThread) => child.id !== parent.thread.id
  && child.resourceId === parent.thread.resourceId
  // Native fork clones may omit projectPath; the validated parent/runtime owns
  // their binding. An explicit conflicting child path is never accepted.
  && (child.metadata?.projectPath === undefined || child.metadata.projectPath === parent.binding.cwd)
  && child.metadata?.forkedSubagent === true && child.metadata?.parentThreadId === parent.thread.id;

/** Interpret only the supported native subagent invocation result/argument fields.
 * There is no persisted ordinary-child transcript and no invented call/fork link.
 */
function invocations(messages: NativeHistoryMessage[], live: Map<string, ActiveSubagentState>): SubagentInvocation[] {
  const rows = new Map<string, SubagentInvocation>();
  for (const message of messages) for (const part of message.content.parts) {
    if (part.type !== 'tool-invocation' || part.toolInvocation.toolName !== 'subagent') continue;
    const call = part.toolInvocation;
    const args: Record<string, unknown> = object(call.args) ? call.args : {};
    const outer: Record<string, unknown> = call;
    const result = outer.result;
    const output = object(result) ? result : undefined;
    const failed = outer.isError === true || outer.state === 'output-error' || outer.state === 'output-denied' || output?.isError === true;
    rows.set(call.toolCallId, { id: call.toolCallId, agentType: text(args.agentType), task: text(args.task), modelId: text(args.modelId),
      forked: args.forked === true,
      status: failed ? 'error' : call.state === 'result' ? 'completed' : 'unknown',
      result: text(output?.content) ?? text(result) ?? text(outer.errorText), activity: null });
  }
  for (const [id, activity] of live) {
    const saved = rows.get(id);
    rows.set(id, { id, agentType: activity.agentType, task: activity.task, modelId: activity.modelId ?? saved?.modelId ?? null,
      forked: activity.forked ?? saved?.forked ?? false,
      status: saved?.status === 'completed' || saved?.status === 'error' ? saved.status : activity.status,
      result: saved?.result ?? activity.result ?? null, activity });
  }
  return [...rows.values()];
}

/** Read-only native projection. Invalidation connects dormant observers to later
 * parent mounting; no polling, child activation or duplicate transcript storage.
 */
export function createChatSubagents(options: { resolveParent: (chatId: string) => Promise<Parent>; signal: AbortSignal }) {
  const epoch = randomUUID();
  const revisions = new Map<string, number>();
  const revisionOf = (chatId: string) => revisions.get(chatId) ?? 0;
  const publisher = new EventPublisher<Record<string, number>>({ maxBufferedEvents: 1 });
  options.signal.addEventListener('abort', () => revisions.clear(), { once: true });
  async function parentFor(chatId: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    const parent = await options.resolveParent(chatId);
    if (parent.thread.id !== chatId || !ownsThread(parent.binding, parent.thread)) throw missing();
    if (parent.session && (parent.session.thread.getId() !== chatId || parent.session.identity.getResourceId() !== parent.thread.resourceId)) throw missing();
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    return parent;
  }
  const liveOf = (parent: Parent) => structuredClone(parent.session?.displayState.get().activeSubagents ?? new Map<string, ActiveSubagentState>());
  async function list(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal): Promise<SubagentList> {
    let request = input.history;
    for (;;) {
      const startedAt = revisionOf(input.chatId);
      const parent = await parentFor(input.chatId, signal);
      const live = liveOf(parent);
      const history = await readChatHistory(parent.runtime.controller, { threadId: parent.thread.id, resourceId: parent.thread.resourceId }, request, signal);
      const children = await parent.runtime.controller.queryThreads({ resourceId: parent.thread.resourceId,
        includeForkedSubagents: true, metadata: { parentThreadId: parent.thread.id } });
      signal?.throwIfAborted(); options.signal.throwIfAborted();
      // Preserve an older-load boundary across retries rather than expanding twice.
      if (revisionOf(input.chatId) !== startedAt) { request = history.history.earliest ? { earliest: history.history.earliest } : request; continue; }
      return { epoch, revision: startedAt, chatId: input.chatId, invocations: invocations(history.messages, live),
        forks: children.filter(child => isChild(parent, child)).map(child => ({ id: child.id, title: child.title ?? 'Forked subagent' })), history: history.history };
    }
  }
  async function open(input: SubagentSelection, signal?: AbortSignal): Promise<SubagentSnapshot> {
    if (input.kind === 'invocation') {
      const inventory = await list(input, signal);
      const invocation = inventory.invocations.find(row => row.id === input.id);
      if (!invocation) throw missing();
      return { epoch: inventory.epoch, revision: inventory.revision, chatId: input.chatId, kind: input.kind, id: input.id,
        invocation, messages: [], history: inventory.history };
    }
    if (input.kind !== 'fork') throw new ORPCError('BAD_REQUEST', { message: 'Invalid subagent kind.' });
    let request = input.history;
    for (;;) {
      const startedAt = revisionOf(input.chatId);
      const parent = await parentFor(input.chatId, signal);
      const child = await parent.runtime.controller.queryThreadById({ threadId: input.id });
      if (!child || !isChild(parent, child)) throw missing();
      const history: ChatHistory = await readChatHistory(parent.runtime.controller, { threadId: child.id, resourceId: child.resourceId }, request, signal);
      signal?.throwIfAborted(); options.signal.throwIfAborted();
      if (revisionOf(input.chatId) !== startedAt) { request = history.history.earliest ? { earliest: history.history.earliest } : request; continue; }
      return { epoch, revision: startedAt, chatId: input.chatId, kind: input.kind, id: input.id, invocation: null, ...history };
    }
  }
  async function* watch<T extends { revision: number; history: HistoryBoundary }>(
    chatId: string, read: (history: HistoryRequest | undefined, signal: AbortSignal) => Promise<T>, history?: HistoryRequest, signal?: AbortSignal,
  ): AsyncGenerator<T, void> {
    const combined = AbortSignal.any([options.signal, ...(signal ? [signal] : [])]);
    const changes = publisher.subscribe(chatId, { signal: combined });
    try {
      let last = await read(history, combined); yield last;
      for await (const current of changes) {
        if (current <= last.revision) continue;
        last = await read(last.history.earliest ? { earliest: last.history.earliest } : undefined, combined);
        yield last;
      }
    } finally { await changes.return(); }
  }
  return {
    invalidate(chatId: string, publish = true) {
      const revision = revisionOf(chatId) + 1; revisions.set(chatId, revision);
      if (publish) publisher.publish(chatId, revision);
    },
    list, open,
    watchList(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) {
      return watch(input.chatId, (history, combined) => list({ ...input, history }, combined), input.history, signal);
    },
    watch(input: SubagentSelection, signal?: AbortSignal) {
      return watch(input.chatId, (history, combined) => open({ ...input, history }, combined), input.history, signal);
    },
  };
}
