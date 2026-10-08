import { readNativePromptViews, type NativePrompt } from './chat-prompts.js';
import { randomUUID } from 'node:crypto';
import { readChildRelation } from './child-relation.js';
import { readChatDescendants } from './chat-descendants.js';
import { resolveChatThreadRoute, type ChatThreadRoute } from './chat-thread-route.js';
import { EventPublisher, ORPCError } from '@orpc/server';
import type { ActiveSubagentState } from '@mastra/core/agent-controller';
import type { NativeThread } from './chat-projects.js';
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
  childPrompts: Array<{ prompt: NativePrompt; ownerTitle: string }>;
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
interface Parent extends ChatThreadRoute {
  binding: RuntimeBinding;
  runtime: ProjectRuntime;
  session?: NativeSession;
}
const missing = () => new ORPCError('NOT_FOUND', { message: 'Subagent or parent chat not found.' });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : null;
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
  const childListeners = new Map<NativeSession, { off: () => void; roots: Set<string> }>();
  const observedRoots = new Map<ProjectRuntime, Set<string>>();
  function invalidate(chatId: string, publish = true) {
    const revision = revisionOf(chatId) + 1; revisions.set(chatId, revision);
    if (publish) publisher.publish(chatId, revision);
  }
  function invalidateRoots(runtime: ProjectRuntime) {
    for (const chatId of observedRoots.get(runtime) ?? []) invalidate(chatId);
  }
  function observeChild(runtime: ProjectRuntime, session: NativeSession, rootId?: string) {
    if (options.signal.aborted) return;
    const tags = session.getTags(), relation = readChildRelation(tags);
    if (!relation || relation.parentSessionScope !== '' || tags.projectPath !== runtime.projectPath) return;
    const existing = childListeners.get(session);
    if (existing) { if (rootId) existing.roots.add(rootId); return; }
    const roots = new Set([relation.parentThreadId, ...(rootId ? [rootId] : [])]);
    const off = session.subscribe(event => {
      for (const chatId of roots) invalidate(chatId, event.type === 'display_state_changed');
    });
    childListeners.set(session, { off, roots });
    for (const chatId of roots) invalidate(chatId);
  }
  function observeRuntime(runtime: ProjectRuntime) {
    if (installed.has(runtime)) return;
    installed.add(runtime);
    runtimeListeners.push(runtime.controller.onSessionCreated(session => {
      observeChild(runtime, session);
      // Creation is rare. Refill observed inventories rather than retain a
      // second ancestry graph to route a newly discovered nested child's root.
      if (readChildRelation(session.getTags())) invalidateRoots(runtime);
    }));
    runtimeListeners.push(runtime.controller.onSessionDeleted(session => {
      const listener = childListeners.get(session);
      listener?.off(); childListeners.delete(session);
      if (readChildRelation(session.getTags())) invalidateRoots(runtime);
    }));
  }
  options.signal.addEventListener('abort', () => {
    for (const off of runtimeListeners) off();
    for (const listener of childListeners.values()) listener.off();
    childListeners.clear(); observedRoots.clear(); installed.clear(); revisions.clear();
  }, { once: true });
  async function liveChild(parent: Parent, child: NativeThread) {
    const session = await parent.runtime.controller.getSessionByResource(child.resourceId);
    if (!session || session.thread.getId() !== child.id) return undefined;
    observeChild(parent.runtime, session, parent.thread.id);
    return session;
  }
  async function parentFor(chatId: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    const parent = await options.resolveParent(chatId);
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    const route = resolveChatThreadRoute(parent.binding, [...parent.ancestors, parent.thread], chatId);
    if (parent.thread.id !== chatId || !route) throw missing();
    observeRuntime(parent.runtime);
    if (parent.session && (parent.session.thread.getId() !== chatId || parent.session.identity.getResourceId() !== parent.thread.resourceId)) throw missing();
    const roots = observedRoots.get(parent.runtime) ?? new Set<string>();
    roots.add(chatId); observedRoots.set(parent.runtime, roots);
    signal?.throwIfAborted(); options.signal.throwIfAborted();
    return { ...parent, ...route };
  }
  async function descendantsOf(parent: Parent, signal?: AbortSignal) {
    // Native forks can omit projectPath. Read from their validated ordinary
    // root, then retain only spawn edges below the selected parent.
    const descendants = await readChatDescendants({ runtime: parent.runtime, parent: parent.root, projectPath: parent.binding.cwd }, signal);
    if (parent.thread.id === parent.root.id) return descendants;
    if (!descendants.some(row => row.thread.id === parent.thread.id)) throw missing();
    const reachable = new Set([parent.thread.id]);
    return descendants.filter(row => {
      if (!reachable.has(row.parentThreadId)) return false;
      reachable.add(row.thread.id); return true;
    });
  }
  const liveOf = (parent: Parent) => structuredClone(parent.session?.displayState.get().activeSubagents ?? new Map<string, ActiveSubagentState>());
  async function list(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal): Promise<SubagentList> {
    let request = input.history;
    for (;;) {
      const startedAt = revisionOf(input.chatId);
      const parent = await parentFor(input.chatId, signal);
      const live = liveOf(parent);
      const history = await readChatHistory(parent.runtime.controller, { threadId: parent.thread.id, resourceId: parent.thread.resourceId }, request, signal);
      const descendants = await descendantsOf(parent, signal);
      const fresh = await Promise.all(descendants.filter(row => row.kind === 'child').map(async ({ thread: child }) => {
        const session = await liveChild(parent, child);
        return { id: child.id, title: child.title ?? 'Delegated child', active: session?.displayState.get().isRunning ?? false,
          prompts: session ? await readNativePromptViews(session, parent.binding.cwd) : [] };
      }));
      signal?.throwIfAborted(); options.signal.throwIfAborted();
      // Preserve an older-load boundary across retries rather than expanding twice.
      if (revisionOf(input.chatId) !== startedAt) { request = history.history.earliest ? { earliest: history.history.earliest } : request; continue; }
      return { epoch, revision: startedAt, chatId: input.chatId, invocations: invocations(history.messages, live),
        forks: descendants.filter(row => row.kind === 'fork').map(({ thread: child }) => ({ id: child.id, title: child.title ?? 'Forked subagent' })), children: fresh.map(({ prompts: _prompts, ...child }) => child),
        childPrompts: fresh.flatMap(child => child.prompts.map(prompt => ({ prompt, ownerTitle: child.title }))), history: history.history };
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
      const descendants = await descendantsOf(parent, signal);
      const child = descendants.find(row => row.kind === input.kind && row.thread.id === input.id)?.thread;
      if (!child) throw missing();
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
