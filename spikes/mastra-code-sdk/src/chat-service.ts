import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EventPublisher, ORPCError } from '@orpc/server';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from './runtime.js';
import { assertProfileActive, type SpikeProfile } from './profile.js';
import { createAccountService } from './account-service.js';
import { captureChatFastRequestContext } from './chat-fast.js';
import { createNativeChatSettings, type ChatSettings, type ChatSettingsPatch } from './chat-settings.js';
import { createSessionProjection, type SessionSnapshot } from './transport.js';

type NativeThread = NonNullable<Awaited<ReturnType<ProjectRuntime['controller']['queryThreadById']>>>;
export interface ChatProject { id: string; name: string; path: string; runtimeRoot: string }
export interface Chat { id: string; projectId: string; title: string; cwd: string }
export interface CatalogSnapshot { epoch: string; revision: number; chats: Chat[] }
export interface ChatSnapshot extends SessionSnapshot { chat: Chat; error: string | null; settings: ChatSettings }
export interface ChatServiceOptions {
  profile: SpikeProfile;
  instanceId: string;
  projects: ChatProject[];
  runtimeFactory?: typeof createProjectRuntime;
}
interface Handle {
  project: ChatProject;
  runtime: ProjectRuntime;
  session: NativeSession;
  projection: ReturnType<typeof createSessionProjection>;
  revision: number;
  error: string | null;
  unsubscribe: () => void;
}
const accepted = () => ({ accepted: true as const });
const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });

/** Native thread rows own inventory/history. These maps only keep one mounted
 * runtime/session/projection per identity alive across browser connections.
 */
export function createChatService(options: ChatServiceOptions) {
  const projects = options.projects.map(project => ({ ...project, path: resolve(project.path), runtimeRoot: resolve(project.runtimeRoot) }));
  const projectById = new Map(projects.map(project => [project.id, project]));
  if (projectById.size !== projects.length) throw new Error('Project IDs must be unique.');
  const runtimeFactory = options.runtimeFactory ?? createProjectRuntime;
  const runtimes = new Map<string, Promise<ProjectRuntime>>();
  const handles = new Map<string, Promise<Handle>>();
  const lifetime = new AbortController();
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
  const describe = (project: ChatProject, thread: NativeThread): Chat => ({
    id: thread.id, projectId: project.id, title: thread.title?.trim() || 'New chat', cwd: project.path,
  });
  const ownsThread = (project: ChatProject, thread: NativeThread) => thread.metadata?.projectPath === project.path && thread.metadata?.forkedSubagent !== true;

  async function runtimeFor(project: ChatProject) {
    assertActive();
    let pending = runtimes.get(project.id);
    if (!pending) {
      pending = runtimeFactory({ projectPath: project.path, runtimeRoot: project.runtimeRoot, profile: options.profile });
      runtimes.set(project.id, pending);
      pending.catch(() => { if (runtimes.get(project.id) === pending) runtimes.delete(project.id); });
    }
    const runtime = await pending;
    assertActive();
    return runtime;
  }
  async function inventory() {
    assertActive();
    const chats: Chat[] = [];
    for (const project of projects) {
      const runtime = await runtimeFor(project);
      const threads = await runtime.controller.queryThreads({ metadata: { projectPath: project.path } });
      for (const thread of threads) if (ownsThread(project, thread)) chats.push(describe(project, thread));
    }
    assertActive();
    return chats;
  }
  async function findThread(chatId: string) {
    for (const project of projects) {
      const runtime = await runtimeFor(project);
      const thread = await runtime.controller.queryThreadById({ threadId: chatId });
      if (thread && ownsThread(project, thread)) return { project, runtime, thread };
    }
    throw missing();
  }
  function bind(project: ChatProject, runtime: ProjectRuntime, session: NativeSession): Handle {
    assertActive();
    const projection = createSessionProjection(session);
    const handle: Handle = { project, runtime, session, projection, revision: 0, error: null, unsubscribe: () => {} };
    handle.unsubscribe = session.subscribe(event => {
      handle.revision++;
      if (event.type === 'agent_start') handle.error = null;
      if (event.type === 'error') handle.error = 'The model run failed. Please try again.';
      if (event.type === 'thread_created' || event.type === 'thread_changed' || event.type === 'agent_end' || event.type === 'message_end') invalidateCatalog();
    });
    return handle;
  }
  function cacheHandle(chatId: string, create: () => Promise<Handle>) {
    assertActive();
    const cached = handles.get(chatId);
    if (cached) return cached;
    const pending = create();
    handles.set(chatId, pending);
    pending.catch(() => { if (handles.get(chatId) === pending) handles.delete(chatId); });
    return pending;
  }
  const handleFor = (chatId: string) => cacheHandle(chatId, async () => {
    // Native createSession creates missing thread IDs, so read/validate first.
    const { project, runtime, thread } = await findThread(chatId);
    const session = await runtime.createSession({ resourceId: thread.resourceId, threadId: thread.id });
    return bind(project, runtime, session);
  });

  async function snapshot(handle: Handle, signal?: AbortSignal, initial?: SessionSnapshot): Promise<ChatSnapshot> {
    let supplied = initial;
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const current = supplied ?? await handle.projection.snapshot(signal);
      supplied = undefined;
      if (current.revision !== handle.revision) continue;
      const thread = await handle.runtime.controller.queryThreadById({ threadId: handle.session.thread.requireId() });
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (current.revision !== handle.revision) continue;
      if (!thread || !ownsThread(handle.project, thread)) throw missing();
      const publicSettings = await settings.readChat(handle.session);
      if (current.revision !== handle.revision) continue;
      return { ...current, chat: describe(handle.project, thread), error: handle.error, settings: publicSettings };
    }
  }
  async function catalogSnapshot(signal?: AbortSignal): Promise<CatalogSnapshot> {
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const revision = catalogRevision;
      const chats = await inventory();
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (revision === catalogRevision) return { epoch, revision, chats };
    }
  }
  async function sendNative(handle: Handle, text: string) {
    try {
      const submission = handle.session.sendSignal({ content: text, requestContext: await captureChatFastRequestContext(handle.session) }, { requireDelivery: true });
      const decision = await submission.accepted;
      if (decision.action === 'blocked') throw new ORPCError('CONFLICT', { message: 'This chat is waiting for a tool response.' });
      if (decision.action !== 'wake' && decision.action !== 'deliver') throw new Error('Native input was not admitted to a run.');
      return accepted();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat input could not be accepted.' });
    }
  }

  const defaultsRuntime = async () => {
    const project = projects[0];
    if (!project) throw missing();
    return runtimeFor(project);
  };

  return {
    async getAccount() { return (await accounts()).get(); },
    async logoutAccount() { return (await accounts()).logout(); },
    async getAccountUsage(signal?: AbortSignal) { return (await accounts()).getUsage(signal); },
    async *watchAccount(signal?: AbortSignal) { yield* (await accounts()).watch(signal); },
    async listModels({ projectId }: { projectId: string }) {
      const project = projectById.get(projectId);
      if (!project) throw missing();
      return settings.listModels(await runtimeFor(project));
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
    async getDraftDefaults() { return settings.getDefaults(await defaultsRuntime()); },
    async updateDraftDefaults({ version, patch }: { version: string; patch: ChatSettingsPatch }) {
      const current = await settings.updateDefaults(await defaultsRuntime(), version, patch);
      for (const pending of handles.values()) {
        const handle = await pending;
        handle.session.emit({ type: 'display_state_changed', displayState: handle.session.displayState.get() });
      }
      return current;
    },
    async *watchDraftDefaults(signal?: AbortSignal) {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      yield* settings.watchDefaults(await defaultsRuntime(), combined);
    },
    async info() {
      assertActive();
      return { instanceId: options.instanceId, projects: projects.map(({ id, name, path }) => ({ id, name, path })) };
    },
    async listChats() { return catalogSnapshot(); },
    async createChat({ projectId, settings: draft }: { projectId: string; settings?: ChatSettingsPatch }) {
      assertActive();
      const project = projectById.get(projectId);
      if (!project) throw missing();
      const chatId = randomUUID();
      const resourceId = randomUUID();
      const handle = await cacheHandle(chatId, async () => {
        const runtime = await runtimeFor(project);
        const defaults = await settings.getDefaults(runtime);
        await settings.validate(runtime, draft ?? {}, defaults.modelId);
        const session = await runtime.createSession({ resourceId, threadId: chatId });
        await settings.updateChat(runtime, session, { modelId: defaults.modelId, ...draft });
        return bind(project, runtime, session);
      });
      const created = await snapshot(handle);
      invalidateCatalog();
      return created.chat;
    },
    async openChat({ chatId }: { chatId: string }, signal?: AbortSignal) {
      return snapshot(await handleFor(chatId), signal);
    },
    async *watchChat({ chatId }: { chatId: string }, signal?: AbortSignal): AsyncGenerator<ChatSnapshot, void> {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const handle = await handleFor(chatId);
      for await (const current of handle.projection.watch(combined)) yield await snapshot(handle, combined, current);
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
    async send({ chatId, text }: { chatId: string; text: string }) {
      return sendNative(await handleFor(chatId), text);
    },
    async queue({ chatId, text }: { chatId: string; text: string }) {
      const handle = await handleFor(chatId);
      // Native followUp sends immediately while idle but awaits that whole run.
      // Use the same native idle Send primitive for a prompt RPC acknowledgment.
      if (!handle.session.run.isRunning()) return sendNative(handle, text);
      try { await handle.session.followUp({ content: text, requestContext: await captureChatFastRequestContext(handle.session) }); }
      catch { throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat input could not be queued.' }); }
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
          result.value.unsubscribe();
          result.value.projection.dispose();
        }
        const loadedRuntimes = await Promise.allSettled(runtimes.values());
        const results = await Promise.allSettled(loadedRuntimes.filter((result): result is PromiseFulfilledResult<ProjectRuntime> => result.status === 'fulfilled').map(result => result.value.dispose()));
        handles.clear(); runtimes.clear();
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return disposal;
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
