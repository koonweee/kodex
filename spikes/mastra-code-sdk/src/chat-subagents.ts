import { randomUUID } from 'node:crypto';
import { readChildRelation } from './child-relation.js';
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
  children: Array<{ id: string; title: string; active: boolean }>;
  history: HistoryBoundary;
}
export interface SubagentSelection { chatId: string; kind: 'invocation' | 'fork' | 'child'; id: string; history?: HistoryRequest }
export interface SubagentSnapshot {
  epoch: string;
  revision: number;
  chatId: string;
  kind: SubagentSelection['kind'];
  id: string;
  invocation: SubagentInvocation | null;
  messages: NativeHistoryMessage[];
  display?: ReturnType<NativeSession['displayState']['get']>;
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
const isFork = (parent: Parent, child: NativeThread) => child.id !== parent.thread.id
  && child.resourceId === parent.thread.resourceId
  // Native fork clones may omit projectPath; the validated parent/runtime owns
  // their binding. An explicit conflicting child path is never accepted.
  && (child.metadata?.projectPath === undefined || child.metadata.projectPath === parent.binding.cwd)
  && child.metadata?.forkedSubagent === true && child.metadata?.parentThreadId === parent.thread.id;

function isFreshChild(parent: Parent, child: NativeThread) {
  const relation = readChildRelation(child.metadata);
  return child.id !== parent.thread.id && child.resourceId !== parent.thread.resourceId
    && child.metadata?.projectPath === parent.binding.cwd && child.metadata?.forkedSubagent !== true
    && relation?.parentThreadId === parent.thread.id && relation.parentResourceId === parent.thread.resourceId
    && relation.parentSessionScope === '';
}

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
  const installed = new Set<ProjectRuntime>();
  const runtimeListeners: Array<() => void> = [];
  const childListeners = new Map<NativeSession, () => void>();
  function invalidate(chatId: string, publish = true) {
    const revision = revisionOf(chatId) + 1; revisions.set(chatId, revision);
    if (publish) publisher.publish(chatId, revision);
  }
  function observeChild(runtime: ProjectRuntime, session: NativeSession) {
    if (childListeners.has(session) || options.signal.aborted) return;
    const tags = session.getTags(), relation = readChildRelation(tags);
    if (!relation || relation.parentSessionScope !== '' || tags.projectPath !== runtime.projectPath) return;
    childListeners.set(session, session.subscribe(event => invalidate(relation.parentThreadId, event.type === 'display_state_changed')));
    invalidate(relation.parentThreadId);
  }
  function observeRuntime(runtime: ProjectRuntime) {
    if (installed.has(runtime)) return;
    installed.add(runtime);
    runtimeListeners.push(runtime.controller.onSessionCreated(session => observeChild(runtime, session)));
    runtimeListeners.push(runtime.controller.onSessionDeleted(session => {
      childListeners.get(session)?.(); childListeners.delete(session);
      const relation = readChildRelation(session.getTags());
      if (relation) invalidate(relation.parentThreadId);
    }));
  }
  options.signal.addEventListener('abort', () => {
    for (const off of runtimeListeners) off();
    for (const off of childListeners.values()) off();
    childListeners.clear(); installed.clear(); revisions.clear();
  }, { once: true });
  async function liveChild(parent: Parent, child: NativeThread) {
    const session = await parent.runtime.controller.getSessionByResource(child.resourceId);
    if (!session || session.thread.getId() !== child.id) return undefined;
    observeChild(parent.runtime, session);
    return session;
  }
  async function parentFor(chatId: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    const parent = await options.resolveParent(chatId);
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    observeRuntime(parent.runtime);
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
      const children = await parent.runtime.controller.queryThreads({
        includeForkedSubagents: true, metadata: { parentThreadId: parent.thread.id } });
      const fresh = await Promise.all(children.filter(child => isFreshChild(parent, child)).map(async child => ({
        id: child.id, title: child.title ?? 'Delegated child', active: (await liveChild(parent, child))?.displayState.get().isRunning ?? false,
      })));
      signal?.throwIfAborted(); options.signal.throwIfAborted();
      // Preserve an older-load boundary across retries rather than expanding twice.
      if (revisionOf(input.chatId) !== startedAt) { request = history.history.earliest ? { earliest: history.history.earliest } : request; continue; }
      return { epoch, revision: startedAt, chatId: input.chatId, invocations: invocations(history.messages, live),
        forks: children.filter(child => isFork(parent, child)).map(child => ({ id: child.id, title: child.title ?? 'Forked subagent' })), children: fresh, history: history.history };
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
    if (input.kind !== 'fork' && input.kind !== 'child') throw new ORPCError('BAD_REQUEST', { message: 'Invalid subagent kind.' });
    let request = input.history;
    for (;;) {
      const startedAt = revisionOf(input.chatId);
      const parent = await parentFor(input.chatId, signal);
      const child = await parent.runtime.controller.queryThreadById({ threadId: input.id });
      if (!child || !(input.kind === 'fork' ? isFork(parent, child) : isFreshChild(parent, child))) throw missing();
      const live = input.kind === 'child' ? await liveChild(parent, child) : undefined;
      const history: ChatHistory = await readChatHistory(parent.runtime.controller, { threadId: child.id, resourceId: child.resourceId }, request, signal);
      signal?.throwIfAborted(); options.signal.throwIfAborted();
      if (revisionOf(input.chatId) !== startedAt) { request = history.history.earliest ? { earliest: history.history.earliest } : request; continue; }
      return { epoch, revision: startedAt, chatId: input.chatId, kind: input.kind, id: input.id, invocation: null, ...history, ...(live && { display: structuredClone(live.displayState.get()) }) };
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
    invalidate,
    list, open,
    watchList(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) {
      return watch(input.chatId, (history, combined) => list({ ...input, history }, combined), input.history, signal);
    },
    watch(input: SubagentSelection, signal?: AbortSignal) {
      return watch(input.chatId, (history, combined) => open({ ...input, history }, combined), input.history, signal);
    },
  };
}
