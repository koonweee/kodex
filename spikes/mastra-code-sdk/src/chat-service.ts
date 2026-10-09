import { isNativeRetry, logChatRunError } from './chat-run-errors.js';
import { createChatPush } from './chat-push.js';
import type { ChatHandle as Handle } from './chat-service-types.js';
import { createChatNotifications } from './chat-notifications.js';
import { createChatReadState } from './chat-read-state.js';
import { createMcpService } from './mcp-service.js';
import { createChatActivity } from './chat-activity.js';
import { createAutomationService } from './automation-service.js';
import { AUTOMATION_WORKFLOW_ID, createAutomationWorkflow } from './automation-workflow.js';
import { join } from 'node:path';
import { prepareChatInput, type ChatInput } from './chat-input.js';
import { uploadChatImage } from './chat-image-uploads.js';
import { prepareNativeSkills, readNativeSkills } from './chat-skills.js';
import { readChatFilePreview } from './chat-file-previews.js';
import { uploadChatFile } from './chat-uploads.js';
import { readNativePromptViews, respondNativePrompt } from './chat-prompts.js';
import { readChatDescendants } from './chat-descendants.js';
import { randomUUID } from 'node:crypto';
import { pinUnnamedChat, renameNativeChat } from './chat-titles.js';
import { EventPublisher, ORPCError } from '@orpc/server';
import type { NativeSession, ProjectRuntime } from './runtime.js';
import { createChatProjects, type Chat } from './chat-projects.js';
import type { ProjectPatch, RuntimeBinding } from './product-registry.js';
import { assertProfileActive } from './profile.js';
import { createAccountService } from './account-service.js';
import { captureChatFastRequestContext } from './chat-fast.js';
import { createChatQueue, type ChatQueueResult } from './chat-queue.js';
import { createChatRetirement } from './chat-retirement.js';
import { applyChildSessionPolicy } from './child-policy.js';
import { createChatLifecycle } from './chat-lifecycle.js';
import { readChatHistory, type ChatHistory, type HistoryRequest } from './chat-history.js';
import { createChatSubagents, type SubagentSelection } from './chat-subagents.js';
import { createChatGoals, type GoalPatch } from './chat-goals.js';
import { createNativeChatSettings, type ChatSettingsPatch } from './chat-settings.js';
import { createSessionProjection, type SessionSnapshot } from './transport.js';

export type { ChatPresenceSelection } from './chat-presence.js';
export type { UnreadBadge } from './chat-notifications.js';
export type { CatalogSnapshot, ChatSnapshot, ChatPromptResponse, ChatSeenSelection, QueuedSelection, QueuedEdit, QueuedOrder, ChatServiceOptions } from './chat-service-types.js';
import type { CatalogSnapshot, ChatSnapshot, ChatPromptResponse, ChatSeenSelection, QueuedSelection, QueuedEdit, QueuedOrder, ChatServiceOptions } from './chat-service-types.js';

const accepted = () => ({ accepted: true as const });
const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });

/** Native thread rows own inventory/history. These maps only keep one mounted
 * runtime/session/projection per identity alive across browser connections.
 */
export function createChatService(options: ChatServiceOptions) {
  const handles = new Map<string, Promise<Handle>>();
  const imageRoot = join(options.profile.root, 'uploads', 'images');
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
  const activity = createChatActivity(invalidateCatalog);
  const reads = createChatReadState(epoch, (bindingId, threadId) => {
    invalidateCatalog();
    void handles.get(`${bindingId}:${threadId}`)?.then(handle => {
      if (!disposed && !handle.observers.signal.aborted) handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() });
    }, () => {});
  }, event => push.capture(event));
  const projects = createChatProjects(options, assertActive, () => ({
    [AUTOMATION_WORKFLOW_ID]: createAutomationWorkflow(input => lifecycle.admit(input.targetThreadId, async () => {
      const target = await projects.findThread(input.targetThreadId);
      if (input.resourceId !== target.thread.resourceId) throw missing();
      const result = await service.send({ chatId: input.targetThreadId, text: input.prompt, queueIfPending: false });
      if (!result.accepted) throw new Error('Scheduled input was not accepted.');
      return accepted();
    })),
  }), (runtime, bindingId) => { activity.observeRuntime(runtime); reads.observeRuntime(runtime, bindingId); });
  const subagents = createChatSubagents({ signal: lifetime.signal, async resolveParent(chatId) {
    const parent = await projects.resolveThreadRoute(chatId, true);
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
    const queue = createChatQueue(session, { epoch, prepareInput: input => prepareChatInput({ chatId: parentChatId, imageRoot, input, prepareSkills: refs => prepareNativeSkills(session, refs) }), onChanged: () => {
      session.emit({ type: 'display_state_changed', displayState: session.displayState.get() });
    } });
    const handle: Handle = { binding, runtime, session, projection, queue, revision: 0, error: null, unsubscribe: () => {}, observers: new AbortController() };
    handle.unsubscribe = session.subscribe(event => {
      handle.revision++;
      subagents.invalidate(parentChatId, event.type === 'display_state_changed');
      if (event.type === 'agent_start') handle.error = null;
      if (event.type === 'error') {
        if (!isNativeRetry(event)) handle.error = 'The model run failed. Please try again.';
        logChatRunError(parentChatId, event);
      }
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
  async function admitChat<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const route = await projects.resolveThreadRoute(chatId);
    return lifecycle.admitMany([...route.ancestors.map(row => row.id), chatId], run);
  }
  async function handleFor(chatId: string) {
    // Validate ancestry before createSession, which creates missing IDs.
    const { binding, runtime, thread, kind } = await projects.resolveThreadRoute(chatId);
    return cacheHandle(`${binding.id}:${chatId}`, async () => {
      const scope = kind === 'fork'
        ? runtime.sessionsForThread({ resourceId: thread.resourceId, threadId: thread.id })[0]?.scope ?? `kodex:thread:${thread.id}`
        : undefined;
      const session = await runtime.createSession({ resourceId: thread.resourceId, threadId: thread.id, scope },
        kind === 'ordinary' ? undefined : async (session, assertActive) => { await applyChildSessionPolicy(session); assertActive(); });
      return bind(binding, runtime, session);
    });
  }
  const retireChat = createChatRetirement({ projects, lifecycle, handles,
    changed(chatId, bindingId, retiredIds) { reads.forget(bindingId, retiredIds); notifications.forget(bindingId, retiredIds); invalidateCatalog(); subagents.invalidate(chatId); },
  });

  async function snapshot(handle: Handle, signal?: AbortSignal, initial?: SessionSnapshot, request: HistoryRequest = {}): Promise<ChatSnapshot> {
    let supplied = initial;
    // Retry an already-read window without expanding it a second time.
    const history = initial?.history.earliest ? { earliest: initial.history.earliest } : request;
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const readState = reads.read(handle.binding.id, handle.session.thread.requireId());
      const current = supplied ?? await handle.projection.snapshot(signal, history);
      supplied = undefined;
      if (current.revision !== handle.revision) continue;
      const route = await projects.resolveThreadRoute(handle.session.thread.requireId());
      const thread = route.thread;
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (current.revision !== handle.revision) continue;
      if (route.binding.id !== handle.binding.id || thread.resourceId !== handle.session.identity.getResourceId()) throw missing();
      const publicSettings = await settings.readChat(handle.session);
      if (current.revision !== handle.revision) continue;
      const chat = await projects.describe(handle.binding.id, thread);
      if (current.revision !== handle.revision) continue;
      const goal = await goals.read(handle.session);
      if (current.revision !== handle.revision) continue;
      const prompts = await readNativePromptViews(handle.session, handle.binding.cwd);
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      if (current.revision !== handle.revision) continue;
      if (readState.revision !== reads.read(handle.binding.id, chat.id).revision) continue;
      return { ...current, chat, error: handle.error, settings: publicSettings, queue: handle.queue.snapshot(), goal, prompts, readState };
    }
  }
  const notifications = createChatNotifications({ epoch, revision: () => catalogRevision,
    inventory: projects.inventory, projectActivity: activity.project, readState: reads.read, signal: lifetime.signal, assertActive,
    async resolveVisible(ids, apply) {
      const routes = await Promise.all(ids.map(id => projects.resolveThreadRoute(id)));
      await lifecycle.admitMany(routes.flatMap(route => [...route.ancestors.map(row => row.id), route.thread.id]), async () => {
        assertActive(); apply(routes.map(route => ({ bindingId: route.binding.id, threadId: route.thread.id })));
      });
    },
  });
  const catalogSnapshot = notifications.catalogSnapshot;
  const push = createChatPush({ profile: options.profile, options: options.push, async prepare(event) {
    let route;
    try { route = await projects.resolveThreadRoute(event.threadId, true); }
    catch (error) { if (error instanceof ORPCError && error.code === 'NOT_FOUND') return null; throw error; }
    if (route.binding.id !== event.bindingId || route.kind !== 'ordinary' || route.archived
      || !route.chat.notificationsEnabled || notifications.isViewed(event.bindingId, event.threadId)) return null;
    return { title: route.chat.name ?? route.chat.title ?? 'New chat' };
  } });
  async function sendNative(handle: Handle, input: ChatInput, clientId?: string) {
    try {
      const requestContext = await captureChatFastRequestContext(handle.session);
      assertActive();
      const prepared = await prepareChatInput({ chatId: handle.session.thread.requireId(), imageRoot, input, prepareSkills: refs => prepareNativeSkills(handle.session, refs) });
      assertActive();
      const submission = handle.session.sendSignal({ type: 'user', ...prepared,
        ...(clientId !== undefined && { metadata: { ...prepared.metadata, clientId } }),
      }, { requestContext, requireDelivery: true });
      const decision = await submission.accepted;
      if (decision.action === 'blocked') throw new ORPCError('CONFLICT', { message: 'This chat is waiting for a tool response.' });
      if (decision.action !== 'wake' && decision.action !== 'deliver') throw new Error('Native input was not admitted to a run.');
      return accepted();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat input could not be accepted.' });
    }
  }

  async function enqueueNative(handle: Handle, input: ChatInput) {
    assertActive();
    try {
      const submitted = await handle.queue.enqueue(input);
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
    automations: createAutomationService({ runtimes: () => projects.nativeRuntimes(), resolveTarget: chatId => projects.findThread(chatId) }),
    async initializeAutomations() { await projects.nativeRuntimes(); },
    async terminalProjectCwd(projectId: string) { assertActive(); return (await projects.executionBinding(projectId)).cwd; },
    async getAccount() { return (await accounts()).get(); },
    async logoutAccount() { return (await accounts()).logout(); },
    async getAccountUsage(signal?: AbortSignal) { return (await accounts()).getUsage(signal); },
    async *watchAccount(signal?: AbortSignal) { yield* (await accounts()).watch(signal); },
    async listModels(input: { chatId?: string; projectId?: string | null }) {
      const runtime = input.chatId ? (await handleFor(input.chatId)).runtime : await projects.runtimeFor(await projects.executionBinding(input.projectId ?? null));
      return settings.listModels(runtime);
    },
    async listSkills(input: { chatId?: string; projectId?: string | null }) {
      assertActive();
      const binding = input.chatId ? (await projects.resolveThreadRoute(input.chatId)).binding : await projects.executionBinding(input.projectId ?? null);
      try { return { skills: await readNativeSkills(binding.cwd, options.profile.homeDir) }; }
      catch { throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Skills could not be read.' }); }
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
    replaceChatPresence: notifications.replaceChatPresence,
    getUnreadBadge: notifications.getUnreadBadge,
    async markChatSeen({ chatId, ...selection }: ChatSeenSelection) {
      const { binding } = await projects.resolveThreadRoute(chatId);
      assertActive();
      return reads.acknowledge({ ...selection, bindingId: binding.id, threadId: chatId });
    },
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
    async readChatRoute({ chatId }: { chatId: string }) {
      const route = await projects.resolveThreadRoute(chatId);
      const chat = route.chat;
      assertActive();
      return route.kind === 'ordinary' ? { kind: 'ordinary' as const, chat }
        : { kind: route.kind, chat, rootChatId: route.root.id, parentThreadId: route.ancestors.at(-1)!.id };
    },
    async readControlChat({ chatId }: { chatId: string }): Promise<Chat> {
      const { binding, thread } = await projects.findThread(chatId);
      const chat = await projects.describe(binding.id, thread);
      assertActive();
      return chat;
    },
    async readControlHistory({ chatId, history }: { chatId: string; history?: HistoryRequest }): Promise<ChatHistory & { chat: Chat }> {
      const { binding, runtime, thread } = await projects.findThread(chatId);
      const chat = await projects.describe(binding.id, thread);
      const saved = await readChatHistory(runtime.controller, { threadId: thread.id, resourceId: thread.resourceId }, history, lifetime.signal);
      return { chat, ...saved };
    },
    async openChat({ chatId, history }: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal) {
      return snapshot(await handleFor(chatId), signal, undefined, history);
    },
    async *watchChat({ chatId, history }: { chatId: string; history?: HistoryRequest }, signal?: AbortSignal): AsyncGenerator<ChatSnapshot, void> {
      const handle = await admitChat(chatId, () => handleFor(chatId));
      const combined = AbortSignal.any([lifetime.signal, handle.observers.signal, ...(signal ? [signal] : [])]);
      try {
        for await (const current of handle.projection.watch(combined, history)) yield await snapshot(handle, combined, current);
      } catch (error) { if (!combined.aborted) throw error; }
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
    async previewFile({ chatId, path }: { chatId: string; path: string }) {
      assertActive();
      const { binding } = await projects.resolveThreadRoute(chatId, true);
      assertActive();
      return readChatFilePreview({ cwd: binding.cwd, path });
    },
    async uploadFile({ chatId, file }: { chatId: string; file: File }) {
      const { binding } = await projects.resolveThreadRoute(chatId);
      assertActive();
      try { return await uploadChatFile({ cwd: binding.cwd, chatId, file }); }
      catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'File could not be uploaded.' });
      }
    },
    async uploadImage({ chatId, file }: { chatId: string; file: File }) {
      await projects.resolveThreadRoute(chatId);
      assertActive();
      try { return await uploadChatImage({ imageRoot, file }); }
      catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Image could not be uploaded.' });
      }
    },
    async send({ chatId, queueIfPending = false, queueIfEmpty = false, ...input }: ChatInput & { chatId: string; queueIfPending?: boolean; queueIfEmpty?: boolean }) {
      if (queueIfPending && queueIfEmpty) throw new ORPCError('BAD_REQUEST', { message: 'Queue policies cannot both be enabled.' });
      const handle = await handleFor(chatId);
      // Read authoritative native pending work, including input submitted by
      // native extensions. A concurrent drain can still let Send interject into
      // the new active run; the browser never chooses start/steer routing.
      const pending = handle.session.displayState.get().queuedFollowUps > 0;
      if ((queueIfPending && pending) || (queueIfEmpty && !pending)) return enqueueNative(handle, input);
      return sendNative(handle, input);
    },
    async respondPrompt(input: ChatPromptResponse) {
      const { binding, runtime, thread } = await projects.resolveThreadRoute(input.chatId);
      const parent = { ...thread, metadata: { ...thread.metadata, projectPath: binding.cwd } };
      const targetThread = input.target.threadId === thread.id ? thread
        : (await readChatDescendants({ runtime, parent, projectPath: binding.cwd }))
          .find(row => row.kind === 'child' && row.thread.id === input.target.threadId)?.thread;
      if (!targetThread || targetThread.resourceId !== input.target.resourceId) throw missing();
      return admitChat(targetThread.id, async () => {
        // A stale prompt cannot activate a dormant binding. Match the exact
        // native owner, including a directly opened fork's distinct scope.
        const session = runtime.sessionsForThread({ resourceId: targetThread.resourceId, threadId: targetThread.id })
          .find(row => row.session.identity.getId() === input.target.sessionId)?.session
          ?? await runtime.controller.getSessionByResource(targetThread.resourceId);
        if (!session || session.identity.getId() !== input.target.sessionId || session.thread.getId() !== targetThread.id) {
          throw new ORPCError('CONFLICT', { message: 'This native prompt is no longer available.' });
        }
        return respondNativePrompt(session, input, binding.cwd);
      });
    },
    // Match main's nonblocking cards: replies are ordinary native user input,
    // with persisted correlation only (not an idempotency or prompt-state key).
    async replyToQuestion({ chatId, text, clientId }: { chatId: string; text: string; clientId: string }) {
      return sendNative(await handleFor(chatId), { text }, clientId);
    },
    async queue({ chatId, ...input }: ChatInput & { chatId: string }) {
      return enqueueNative(await handleFor(chatId), input);
    },
    async editQueued(selection: QueuedEdit) { return queueCommand(selection, queue => queue.edit(selection)); },
    async removeQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.remove(selection)); },
    async reorderQueued(selection: QueuedOrder) { return queueCommand(selection, queue => queue.reorder(selection)); },
    async steerQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.steer(selection)); },
    async reconcileQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.reconcile(selection)); },
    async dismissQueued(selection: QueuedSelection) { return queueCommand(selection, queue => queue.dismiss(selection)); },
    async archiveChat({ chatId }: { chatId: string }) {
      await retireChat(chatId);
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
      activity.dispose(); reads.dispose(); notifications.dispose();
      disposal = (async () => {
        await push.dispose();
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
    return (input: T, ...args: Args) => admitChat(input.chatId, () => method(input, ...args));
  }
  return { ...service,
    push: push.get,
    mcp: createMcpService({ sources: projects.mcpBindings, assertActive, signal: lifetime.signal }),
    markChatSeen: guarded(service.markChatSeen),
    updateGoal: guarded(service.updateGoal), clearGoal: guarded(service.clearGoal),
    readChatRoute: guarded(service.readChatRoute), readControlChat: guarded(service.readControlChat), readControlHistory: guarded(service.readControlHistory),
    openChat: guarded(service.openChat), getChatSettings: guarded(service.getChatSettings),
    updateChatSettings: guarded(service.updateChatSettings), renameChat: guarded(service.renameChat),
    setChatPinned: guarded(service.setChatPinned), setChatNotifications: guarded(service.setChatNotifications),
    uploadFile: guarded(service.uploadFile), uploadImage: guarded(service.uploadImage),
    send: guarded(service.send), replyToQuestion: guarded(service.replyToQuestion), respondPrompt: guarded(service.respondPrompt), queue: guarded(service.queue), stop: guarded(service.stop),
    editQueued: guarded(service.editQueued), removeQueued: guarded(service.removeQueued),
    reorderQueued: guarded(service.reorderQueued), steerQueued: guarded(service.steerQueued),
    reconcileQueued: guarded(service.reconcileQueued), dismissQueued: guarded(service.dismissQueued),
    async listModels(input: { chatId?: string; projectId?: string | null }) {
      return input.chatId ? admitChat(input.chatId, () => service.listModels(input)) : service.listModels(input);
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
export type { Chat } from './chat-projects.js';
export type { CatalogChat } from './chat-activity.js';
