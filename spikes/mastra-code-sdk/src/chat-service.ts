import { readNativePrompts, respondNativePrompt, type NativePrompt, type PromptResponse } from './chat-prompts.js';
import { readChatDescendants } from './chat-descendants.js';
import { randomUUID } from 'node:crypto';
import { pinUnnamedChat, renameNativeChat } from './chat-titles.js';
import { EventPublisher, ORPCError } from '@orpc/server';
import type { NativeSession, ProjectRuntime } from './runtime.js';
import { createChatProjects, ownsThread, type Chat, type ChatProjectOptions } from './chat-projects.js';
import type { ProductProject, ProjectPatch, RuntimeBinding } from './product-registry.js';
import { assertProfileActive, type SpikeProfile } from './profile.js';
import { createAccountService } from './account-service.js';
import { captureChatFastRequestContext } from './chat-fast.js';
import { createChatQueue, type ChatQueueInput, type ChatQueueSnapshot, type ChatQueueResult } from './chat-queue.js';
import { abortNativeChat, retireChatDescendants } from './chat-archive.js';
import { createChatLifecycle } from './chat-lifecycle.js';
import { readChatHistory, type HistoryRequest } from './chat-history.js';
import { createChatSubagents, type SubagentSelection } from './chat-subagents.js';
import { createChatGoals, type NativeGoal, type GoalPatch } from './chat-goals.js';
import { createNativeChatSettings, type ChatSettings, type ChatSettingsPatch } from './chat-settings.js';
import { createSessionProjection, type SessionSnapshot } from './transport.js';

export interface CatalogSnapshot { epoch: string; revision: number; projects: ProductProject[]; chats: Chat[]; pinnedChatIds: string[]; archivedChatIds: string[] }
export interface ChatSnapshot extends SessionSnapshot { prompts: NativePrompt[]; chat: Chat; error: string | null; settings: ChatSettings; queue: ChatQueueSnapshot; goal: NativeGoal | null }
export type ChatPromptResponse = PromptResponse & { chatId: string };
export interface QueuedSelection { chatId: string; epoch: string; revision: number; id: string }
export interface QueuedEdit extends QueuedSelection { input: ChatQueueInput }
export interface QueuedOrder { chatId: string; epoch: string; revision: number; ids: string[] }
export interface ChatServiceOptions extends ChatProjectOptions {
  profile: SpikeProfile;
  instanceId: string;
}
interface Handle {
  binding: RuntimeBinding;
  runtime: ProjectRuntime;
  session: NativeSession;
  projection: ReturnType<typeof createSessionProjection>;
  queue: ReturnType<typeof createChatQueue>;
  revision: number;
  error: string | null;
  unsubscribe: () => void;
  observers: AbortController;
}
const accepted = () => ({ accepted: true as const });
const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });

/** Native thread rows own inventory/history. These maps only keep one mounted
 * runtime/session/projection per identity alive across browser connections.
 */
export function createChatService(options: ChatServiceOptions) {
  const handles = new Map<string, Promise<Handle>>();
  const lifetime = new AbortController();
  const lifecycle = createChatLifecycle();
  const goals = createChatGoals();
  const catalog = new EventPublisher<{ changed: number }>({ maxBufferedEvents: 1 });
  const epoch = randomUUID();
  const settings = createNativeChatSettings(options.profile, epoch);
  let accountService: Promise<ReturnType<typeof createAccountService>> | undefined;
  async function accounts() {
    assertActive();
    if (!accountService) accountService = (async () => {
      assertProfileActive(options.profile);
      const { getGlobalAuthStorage } = await import('@mastra/code-sdk/agents/mastracode-gateway');
      assertActive();
      return createAccountService(getGlobalAuthStorage(), options.profile.authPath, epoch);
    })().catch(error => { accountService = undefined; throw error; });
    return accountService;
  }
  let catalogRevision = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const assertActive = () => {
    if (disposed) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'The chat service is shutting down.' });
  };
  const invalidateCatalog = () => { catalog.publish('changed', ++catalogRevision); };
  const projects = createChatProjects(options, assertActive);
  const subagents = createChatSubagents({ signal: lifetime.signal, async resolveParent(chatId) {
    const parent = await projects.findThread(chatId, true);
    const handle = await handles.get(`${parent.binding.id}:${chatId}`);
    return { ...parent, ...(handle && !handle.observers.signal.aborted && { session: handle.session }) };
  } });
  function invalidateProjects() {
    invalidateCatalog();
    for (const pending of handles.values()) void pending.then(handle => {
      if (!disposed) handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() });
    }, () => {});
  }
  function bind(binding: RuntimeBinding, runtime: ProjectRuntime, session: NativeSession): Handle {
    assertActive();
    // Bind the native count before projection listeners start: raw extension
    // queue submissions must also participate in existing-chat Send routing.
    session.ensureFollowUpBinding(session.machinery.getAgent(), session.identity.getResourceId(), session.thread.requireId());
    const parentChatId = session.thread.requireId();
    const projection = createSessionProjection(session, (request, signal) => readChatHistory(runtime.controller, { threadId: session.thread.requireId(), resourceId: session.identity.getResourceId() }, request, signal));
    const queue = createChatQueue(session, { epoch, onChanged: () => {
      session.emit({ type: 'display_state_changed', displayState: session.displayState.get() });
    } });
    const handle: Handle = { binding, runtime, session, projection, queue, revision: 0, error: null, unsubscribe: () => {}, observers: new AbortController() };
    handle.unsubscribe = session.subscribe(event => {
      handle.revision++;
      subagents.invalidate(parentChatId, event.type === 'display_state_changed');
      if (event.type === 'agent_start') handle.error = null;
      if (event.type === 'error') handle.error = 'The model run failed. Please try again.';
      if (event.type === 'thread_created' || event.type === 'thread_changed' || event.type === 'thread_title_updated' || event.type === 'agent_end' || event.type === 'message_end') invalidateCatalog();
    });
    subagents.invalidate(parentChatId);
    return handle;
  }
  function cacheHandle(key: string, create: () => Promise<Handle>) {
    assertActive();
    const cached = handles.get(key);
    if (cached) return cached;
    const pending = create();
    handles.set(key, pending);
    pending.catch(() => { if (handles.get(key) === pending) handles.delete(key); });
    return pending;
  }
  async function handleFor(chatId: string) {
    // Validate native inventory before createSession, which creates missing IDs.
    const { binding, runtime, thread } = await projects.findThread(chatId);
    return cacheHandle(`${binding.id}:${chatId}`, async () => {
      const session = await runtime.createSession({ resourceId: thread.resourceId, threadId: thread.id });
      return bind(binding, runtime, session);
    });
  }

  async function snapshot(handle: Handle, signal?: AbortSignal, initial?: SessionSnapshot, request: HistoryRequest = {}): Promise<ChatSnapshot> {
    let supplied = initial;
    // Retry an already-read window without expanding it a second time.
    const history = initial?.history.earliest ? { earliest: initial.history.earliest } : request;
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const current = supplied ?? await handle.projection.snapshot(signal, history);
      supplied = undefined;
      if (current.revision !== handle.revision) continue;
      const thread = await handle.runtime.controller.queryThreadById({ threadId: handle.session.thread.requireId() });
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (current.revision !== handle.revision) continue;
      if (!thread || !ownsThread(handle.binding, thread)) throw missing();
      const publicSettings = await settings.readChat(handle.session);
      if (current.revision !== handle.revision) continue;
      const chat = await projects.describe(handle.binding.id, thread);
      if (current.revision !== handle.revision) continue;
      const goal = await goals.read(handle.session);
      if (current.revision !== handle.revision) continue;
      return { ...current, chat, error: handle.error, settings: publicSettings, queue: handle.queue.snapshot(), goal, prompts: readNativePrompts(handle.session) };
    }
  }
  async function catalogSnapshot(signal?: AbortSignal): Promise<CatalogSnapshot> {
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const revision = catalogRevision;
      const inventory = await projects.inventory();
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (revision === catalogRevision) return { epoch, revision, ...inventory };
    }
  }
  async function sendNative(handle: Handle, text: string, clientId?: string) {
    try {
      const requestContext = await captureChatFastRequestContext(handle.session);
      assertActive();
      const submission = clientId === undefined
        ? handle.session.sendSignal({ content: text, requestContext }, { requireDelivery: true })
        : handle.session.sendSignal({ type: 'user', contents: text, metadata: { clientId } }, { requestContext, requireDelivery: true });
      const decision = await submission.accepted;
      if (decision.action === 'blocked') throw new ORPCError('CONFLICT', { message: 'This chat is waiting for a tool response.' });
      if (decision.action !== 'wake' && decision.action !== 'deliver') throw new Error('Native input was not admitted to a run.');
      return accepted();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat input could not be accepted.' });
    }
  }

  async function enqueueNative(handle: Handle, text: string) {
    assertActive();
    try {
      const submitted = await handle.queue.enqueue({ text });
      return { accepted: submitted.outcome === 'applied', ...submitted };
    } catch {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat input could not be queued.' });
    }
  }
  async function queueCommand(selection: { chatId: string; epoch: string; revision: number }, apply: (queue: Handle['queue']) => Promise<ChatQueueResult>) {
    const handle = await handleFor(selection.chatId);
    assertActive();
    const current = handle.queue.snapshot();
    if (selection.epoch !== current.epoch) return { outcome: 'conflict' as const, snapshot: current };
    try { return await apply(handle.queue); }
    catch { throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Queued input could not be changed.' }); }
  }

  const service = {
    async getAccount() { return (await accounts()).get(); },
    async logoutAccount() { return (await accounts()).logout(); },
    async getAccountUsage(signal?: AbortSignal) { return (await accounts()).getUsage(signal); },
    async *watchAccount(signal?: AbortSignal) { yield* (await accounts()).watch(signal); },
    async listModels(input: { chatId?: string; projectId?: string | null }) {
      const runtime = input.chatId ? (await handleFor(input.chatId)).runtime : await projects.runtimeFor(await projects.executionBinding(input.projectId ?? null));
      return settings.listModels(runtime);
    },
    async listDirectories(input: { path?: string }) { assertActive(); return projects.listDirectories(input); },
    async createProject(input: { createKey: string; path: string }) { const value = await projects.createProject(input); invalidateProjects(); return value; },
    async updateProject(input: { projectId: string; patch: ProjectPatch }) { const value = await projects.updateProject(input); invalidateProjects(); return value; },
    async deleteProject(input: { projectId: string }) { await projects.deleteProject(input); invalidateProjects(); return accepted(); },
    async moveProjectBefore(input: { projectId: string; beforeId: string | null }) { await projects.moveProjectBefore(input); invalidateProjects(); return accepted(); },
    async setChatPinned(input: { chatId: string; pinned: boolean; beforeChatId?: string | null }) { await projects.setChatPinned(input); invalidateProjects(); return accepted(); },
    async setChatNotifications(input: { chatId: string; enabled: boolean }) { await projects.setChatNotifications(input); invalidateProjects(); return accepted(); },
    async renameChat({ chatId, title }: { chatId: string; title: string }) {
      const name = title.trim();
      if (!name) throw new ORPCError('BAD_REQUEST', { message: 'Chat name cannot be empty.' });
      const handle = await handleFor(chatId);
      assertActive();
      try { await renameNativeChat(handle.session, name); }
      catch { throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat name could not be changed.' }); }
      invalidateCatalog();
      handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() });
      return accepted();
    },
    async updateGoal({ chatId, patch }: { chatId: string; patch: GoalPatch }) {
      const handle = await handleFor(chatId);
      try { await goals.update(handle.session, patch); }
      finally { handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() }); }
      return accepted();
    },
    async clearGoal({ chatId }: { chatId: string }) {
      const handle = await handleFor(chatId);
      try { await goals.clear(handle.session); }
      finally { handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() }); }
      return accepted();
    },
    async getChatSettings({ chatId }: { chatId: string }) {
      const current = await snapshot(await handleFor(chatId));
      return { epoch: current.epoch, revision: current.revision, ...current.settings };
    },
    async updateChatSettings({ chatId, patch }: { chatId: string; patch: ChatSettingsPatch }) {
      const handle = await handleFor(chatId);
      await settings.updateChat(handle.runtime, handle.session, patch);
      const current = await snapshot(handle);
      return { epoch: current.epoch, revision: current.revision, ...current.settings };
    },
    async getDraftDefaults() { return settings.getDefaults(await projects.defaultsRuntime()); },
    async updateDraftDefaults({ version, patch }: { version: string; patch: ChatSettingsPatch }) {
      const current = await settings.updateDefaults(await projects.defaultsRuntime(), version, patch);
      for (const pending of handles.values()) {
        const handle = await pending;
        handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() });
      }
      return current;
    },
    async *watchDraftDefaults(signal?: AbortSignal) {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      yield* settings.watchDefaults(await projects.defaultsRuntime(), combined);
    },
    async info() {
      assertActive();
      return { instanceId: options.instanceId };
    },
    async listChats() { return catalogSnapshot(); },
    listSubagents(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) { return subagents.list(input, signal); },
    watchSubagents(input: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) { return subagents.watchList(input, signal); },
    openSubagent(input: SubagentSelection, signal?: AbortSignal) { return subagents.open(input, signal); },
    watchSubagent(input: SubagentSelection, signal?: AbortSignal) { return subagents.watch(input, signal); },
    async createChat({ projectId = null, settings: draft }: { projectId?: string | null; settings?: ChatSettingsPatch }) {
      assertActive();
      const binding = await projects.executionBinding(projectId);
      const chatId = randomUUID();
      const resourceId = randomUUID();
      return lifecycle.admit(chatId, async () => {
        const handle = await cacheHandle(`${binding.id}:${chatId}`, async () => {
          const runtime = await projects.runtimeFor(binding);
          const defaults = await settings.getDefaults(runtime);
          await settings.validate(runtime, draft ?? {}, defaults.modelId);
          const session = await runtime.createSession({ resourceId, threadId: chatId });
          await settings.updateChat(runtime, session, { modelId: defaults.modelId, ...draft });
          await pinUnnamedChat(session);
          return bind(binding, runtime, session);
        });
        const created = await snapshot(handle);
        invalidateCatalog();
        return created.chat;
      });
    },
    async openChat({ chatId, history }: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) {
      return snapshot(await handleFor(chatId), signal, undefined, history);
    },
    async *watchChat({ chatId, history }: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal): AsyncGenerator<ChatSnapshot, void> {
      const handle = await lifecycle.admit(chatId, () => handleFor(chatId));
      const combined = AbortSignal.any([lifetime.signal, handle.observers.signal, ...(signal ? [signal] : [])]);
      for await (const current of handle.projection.watch(combined, history)) yield await snapshot(handle, combined, current);
    },
    async *watchCatalog(signal?: AbortSignal): AsyncGenerator<CatalogSnapshot, void> {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const changes = catalog.subscribe('changed', { signal: combined });
      try {
        let last = await catalogSnapshot(combined);
        yield last;
        for await (const revision of changes) {
          if (revision <= last.revision) continue;
          last = await catalogSnapshot(combined);
          yield last;
        }
      } finally { await changes.return(); }
    },
    async send({ chatId, text, queueIfPending = false }: { chatId: string; text: string; queueIfPending?: boolean }) {
      const handle = await handleFor(chatId);
      // Read authoritative native pending work, including input submitted by
      // native extensions. A concurrent drain can still let Send interject into
      // the new active run; the browser never chooses start/steer routing.
      if (queueIfPending && handle.session.displayState.get().queuedFollowUps > 0) return enqueueNative(handle, text);
      return sendNative(handle, text);
    },
    async respondPrompt(input: ChatPromptResponse) {
      const { binding, runtime, thread } = await projects.findThread(input.chatId);
      const targetThread = input.target.threadId === thread.id ? thread
        : (await readChatDescendants({ runtime, parent: thread, projectPath: binding.cwd }))
          .find(row => row.kind === 'child' && row.thread.id === input.target.threadId)?.thread;
      if (!targetThread || targetThread.resourceId !== input.target.resourceId) throw missing();
      // A stale prompt cannot activate a dormant parent or child. Resume only the
      // exact already-mounted native owner; native prompt claims arbitrate peers.
      const session = await runtime.controller.getSessionByResource(targetThread.resourceId);
      if (!session || session.identity.getId() !== input.target.sessionId || session.thread.getId() !== targetThread.id) {
        throw new ORPCError('CONFLICT', { message: 'This native prompt is no longer available.' });
      }
      return respondNativePrompt(session, input);
    },
    // Match main's nonblocking cards: replies are ordinary native user input,
    // with persisted correlation only (not an idempotency or prompt-state key).
    async replyToQuestion({ chatId, text, clientId }: { chatId: string; text: string; clientId: string }) {
      return sendNative(await handleFor(chatId), text, clientId);
    },
    async queue({ chatId, text }: { chatId: string; text: string }) {
      return enqueueNative(await handleFor(chatId), text);
    },
    async editQueued(selection: QueuedEdit) { return queueCommand(selection, queue => queue.edit(selection)); },
    async removeQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.remove(selection)); },
    async reorderQueued(selection: QueuedOrder) { return queueCommand(selection, queue => queue.reorder(selection)); },
    async steerQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.steer(selection)); },
    async reconcileQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.reconcile(selection)); },
    async dismissQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.dismiss(selection)); },
    async archiveChat({ chatId }: { chatId: string }) {
      await lifecycle.retire(chatId, async () => {
        const { binding, runtime, thread } = await projects.findThread(chatId, true);
        const key = `${binding.id}:${chatId}`;
        const handle = await handles.get(key);
        handle?.observers.abort();
        const session = handle?.session ?? await runtime.controller.getSessionByResource(thread.resourceId);
        if (session) {
          await abortNativeChat(session);
          handle?.queue.dispose();
        }
        handle?.unsubscribe();
        handle?.projection.dispose();
        handles.delete(key);
        // Native deletion can clear/drop its Session before rejecting. A retry
        // must consult native registration, never a cleared cached Session.
        if (session) await runtime.releaseSession({ resourceId: thread.resourceId });
        const descendantThreadIds = await retireChatDescendants(runtime, thread, binding.cwd);
        await projects.archiveChat(binding.id, thread.id, descendantThreadIds);
        invalidateCatalog();
        subagents.invalidate(chatId);
      });
      return accepted();
    },
    async stop({ chatId }: { chatId: string }) {
      const handle = await handleFor(chatId);
      handle.session.abort();
      return accepted();
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      lifetime.abort();
      disposal = (async () => {
        if (accountService) await accountService.then(service => service.dispose(), () => {});
        const loadedHandles = await Promise.allSettled(handles.values());
        for (const result of loadedHandles) if (result.status === 'fulfilled') {
          result.value.queue.dispose();
          result.value.unsubscribe();
          result.value.projection.dispose();
        }
        handles.clear();
        await projects.dispose();
      })();
      return disposal;
    },
  };
  function guarded<T extends { chatId: string }, Args extends unknown[], Result>(method: (input: T, ...args: Args) => Promise<Result>) {
    return (input: T, ...args: Args) => lifecycle.admit(input.chatId, () => method(input, ...args));
  }
  return { ...service,
    updateGoal: guarded(service.updateGoal), clearGoal: guarded(service.clearGoal),
    openChat: guarded(service.openChat), getChatSettings: guarded(service.getChatSettings),
    updateChatSettings: guarded(service.updateChatSettings), renameChat: guarded(service.renameChat),
    setChatPinned: guarded(service.setChatPinned), setChatNotifications: guarded(service.setChatNotifications),
    send: guarded(service.send), replyToQuestion: guarded(service.replyToQuestion), respondPrompt: guarded(service.respondPrompt), queue: guarded(service.queue), stop: guarded(service.stop),
    editQueued: guarded(service.editQueued), removeQueued: guarded(service.removeQueued),
    reorderQueued: guarded(service.reorderQueued), steerQueued: guarded(service.steerQueued),
    reconcileQueued: guarded(service.reconcileQueued), dismissQueued: guarded(service.dismissQueued),
    async listModels(input: { chatId?: string; projectId?: string | null }) {
      return input.chatId ? lifecycle.admit(input.chatId, () => service.listModels(input)) : service.listModels(input);
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
export type { Chat } from './chat-projects.js';
