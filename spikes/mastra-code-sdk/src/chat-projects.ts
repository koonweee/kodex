import { ownsThread, resolveChatThreadRoute } from './chat-thread-route.js';
export { ownsThread } from './chat-thread-route.js';
import { basename } from 'node:path';
import { readChatName, readChatTitle } from './chat-titles.js';
import { homedir } from 'node:os';
import { ORPCError } from '@orpc/server';
import { createProjectRuntime, type ProjectRuntime, type ProjectRuntimeOptions } from './runtime.js';
import { openProductRegistry, ProductRegistryError, type ProductRegistry, type ProjectSeed, type ProjectPatch, type RuntimeBinding, type ChatMetadata } from './product-registry.js';
import { listProjectDirectories } from './project-directories.js';
import type { SpikeProfile } from './profile.js';

export type NativeThread = NonNullable<Awaited<ReturnType<ProjectRuntime['controller']['queryThreadById']>>>;
export interface Chat { id: string; projectId: string | null; title: string; name: string | null; cwd: string; pinned: boolean; notificationsEnabled: boolean }
export interface PinnedDescendant extends Chat { kind: 'child' | 'fork'; rootChatId: string; parentThreadId: string }
export interface ChatProjectOptions {
  profile: SpikeProfile;
  projects?: ProjectSeed[];
  directoryHome?: string;
  registryFactory?: () => Promise<ProductRegistry>;
  runtimeFactory?: typeof createProjectRuntime;
}
const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });
const describeChat = (binding: RuntimeBinding, thread: NativeThread, title: string, metadata?: ChatMetadata): Chat => ({ id: thread.id, projectId: binding.projectId, title, name: readChatName(thread), cwd: binding.cwd, pinned: metadata?.pinPosition !== undefined && metadata.pinPosition !== null, notificationsEnabled: metadata?.notificationsEnabled ?? true });

/** Product membership is read from the registry. Native runtimes remain attached
 * to immutable binding identities and cwd, including detached standalone chats.
 */
export function createChatProjects(options: ChatProjectOptions, assertActive: () => void, workflows?: () => ProjectRuntimeOptions['workflows']) {
  const runtimes = new Map<string, Promise<ProjectRuntime>>();
  let pendingRegistry: Promise<ProductRegistry> | undefined;
  const home = options.directoryHome ?? homedir();
  async function registry() {
    assertActive();
    if (!pendingRegistry) {
      const pending = (async () => {
        const store = await (options.registryFactory?.() ?? openProductRegistry(options.profile, { standaloneCwd: home }));
        try { assertActive(); await store.seedProjects(options.projects ?? []); return store; }
        catch (error) { await store.close(); throw error; }
      })();
      pendingRegistry = pending;
      void pending.catch(() => { if (pendingRegistry === pending) pendingRegistry = undefined; });
    }
    return pendingRegistry;
  }
  async function registryCall<T>(run: (store: ProductRegistry) => Promise<T>): Promise<T> {
    try { const result = await run(await registry()); assertActive(); return result; }
    catch (error) {
      if (error instanceof ORPCError) throw error;
      if (error instanceof ProductRegistryError) {
        const code = error.code === 'NOT_FOUND' ? 'NOT_FOUND' : error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : 'CONFLICT';
        throw new ORPCError(code, { message: error.message });
      }
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Project metadata could not be read or changed.' });
    }
  }
  async function runtimeFor(binding: RuntimeBinding): Promise<ProjectRuntime> {
    assertActive();
    let pending = runtimes.get(binding.id);
    if (!pending) {
      pending = (options.runtimeFactory ?? createProjectRuntime)({ projectPath: binding.cwd, runtimeRoot: binding.runtimeRoot, profile: options.profile, ...(workflows && { workflows: workflows() }) });
      runtimes.set(binding.id, pending);
      void pending.catch(() => { if (runtimes.get(binding.id) === pending) runtimes.delete(binding.id); });
    }
    const runtime = await pending;
    assertActive();
    return runtime;
  }
  const executionBinding = (projectId: string | null) => registryCall(store => store.executionBinding(projectId));
  const listBindings = () => registryCall(store => store.listBindings());
  async function currentBinding(id: string) {
    const value = (await listBindings()).find(binding => binding.id === id);
    if (!value) throw missing();
    return value;
  }
  async function inventory() {
    for (;;) {
      const snapshot = await registryCall(store => store.snapshot());
      const metadata = await registryCall(store => store.chatMetadataSnapshot());
      if (metadata.revision !== snapshot.revision) continue;
      const byIdentity = new Map(metadata.entries.map(entry => [JSON.stringify([entry.bindingId, entry.threadId]), entry]));
      const bindings = await listBindings();
      const chats: Chat[] = [];
      const pinnedDescendants: PinnedDescendant[] = [];
      const catalogs: Array<{ binding: RuntimeBinding; runtime: ProjectRuntime; threads: NativeThread[] }> = [];
      const archivedChatIds: string[] = [];
      const nativeIdentities = new Set<string>();
      for (const binding of bindings) {
        const runtime = await runtimeFor(binding);
        const threads = await runtime.controller.queryThreads({ includeForkedSubagents: true });
        catalogs.push({ binding, runtime, threads });
        for (const thread of threads) if (ownsThread(binding, thread)) {
          const identity = JSON.stringify([binding.id, thread.id]);
          if (byIdentity.get(identity)?.archived) { archivedChatIds.push(thread.id); continue; }
          nativeIdentities.add(identity);
          chats.push(describeChat(binding, thread, await readChatTitle(runtime, thread), byIdentity.get(identity)));
        }
      }
      for (const entry of metadata.entries) if (entry.archived && !archivedChatIds.includes(entry.threadId)) {
        const catalog = catalogs.find(row => row.binding.id === entry.bindingId);
        if (catalog && resolveChatThreadRoute(catalog.binding, catalog.threads, entry.threadId)) archivedChatIds.push(entry.threadId);
      }
      // Only pinned descendant rows need additional projection. Resolve against
      // the same native catalog read, including cross-binding ambiguity, rather
      // than adding descendants to ordinary project/chat membership.
      for (const entry of metadata.entries) if (entry.pinPosition !== null && !entry.archived) {
        const matches = catalogs.flatMap(catalog => {
          const route = resolveChatThreadRoute(catalog.binding, catalog.threads, entry.threadId);
          return route ? [{ ...catalog, route }] : [];
        });
        const match = matches[0];
        if (matches.length !== 1 || !match || match.binding.id !== entry.bindingId) continue;
        const { route, binding, runtime } = match;
        if (route.kind === 'ordinary') continue;
        const ancestry = [...route.ancestors, route.thread];
        if (ancestry.some(thread => byIdentity.get(JSON.stringify([binding.id, thread.id]))?.archived)) continue;
        pinnedDescendants.push({ ...describeChat(binding, route.thread, await readChatTitle(runtime, route.thread), entry),
          kind: route.kind, rootChatId: route.root.id, parentThreadId: route.ancestors.at(-1)!.id });
        nativeIdentities.add(JSON.stringify([binding.id, route.thread.id]));
      }
      assertActive();
      if ((await registryCall(store => store.snapshot())).revision === snapshot.revision) {
        const pinnedChatIds = metadata.entries.filter(entry => entry.pinPosition !== null && nativeIdentities.has(JSON.stringify([entry.bindingId, entry.threadId]))).sort((left, right) => left.pinPosition! - right.pinPosition!).map(entry => entry.threadId);
        const byId = new Map(pinnedDescendants.map(chat => [chat.id, chat]));
        return { projects: snapshot.projects, chats, pinnedDescendants: pinnedChatIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), pinnedChatIds, archivedChatIds };
      }
    }
  }
  async function findThread(chatId: string, includeArchived = false) {
    for (const binding of await listBindings()) {
      const runtime = await runtimeFor(binding);
      const thread = await runtime.controller.queryThreadById({ threadId: chatId });
      if (thread && ownsThread(binding, thread)) {
        if (!includeArchived) {
          const metadata = await registryCall(store => store.chatMetadataSnapshot());
          if (metadata.entries.some(row => row.bindingId === binding.id && row.threadId === thread.id && row.archived)) throw new ORPCError('CONFLICT', { message: 'This chat is archived.' });
        }
        return { binding, runtime, thread };
      }
    }
    throw missing();
  }
  async function resolveThreadRoute(chatId: string, includeArchived = false) {
    for (;;) {
      const metadata = await registryCall(store => store.chatMetadataSnapshot());
      const matches = [];
      for (const binding of await listBindings()) {
        const runtime = await runtimeFor(binding);
        const rows = await runtime.controller.queryThreads({ includeForkedSubagents: true });
        const route = resolveChatThreadRoute(binding, rows, chatId);
        if (!route) continue;
        const ancestry = new Set([...route.ancestors, route.thread].map(thread => thread.id));
        const archived = metadata.entries.some(entry => entry.bindingId === binding.id && ancestry.has(entry.threadId) && entry.archived);
        matches.push({ binding, runtime, ...route, archived });
      }
      const match = matches[0];
      const chat = matches.length === 1 && match && (!match.archived || includeArchived)
        ? describeChat(match.binding, match.thread, await readChatTitle(match.runtime, match.thread),
          metadata.entries.find(entry => entry.bindingId === match.binding.id && entry.threadId === chatId)) : null;
      assertActive();
      if ((await registryCall(store => store.snapshot())).revision !== metadata.revision) continue;
      if (matches.length > 1) throw new ORPCError('CONFLICT', { message: 'Chat identity is ambiguous.' });
      if (!match) throw missing();
      if (match.archived && !includeArchived) throw new ORPCError('CONFLICT', { message: 'This chat is archived.' });
      return { ...match, chat: chat! };
    }
  }
  async function canonicalRoots(paths: string[]) {
    return Promise.all(paths.map(async path => (await listProjectDirectories({ home, path })).path));
  }
  return {
    runtimeFor, executionBinding, currentBinding, inventory, findThread, resolveThreadRoute,
    async nativeRuntimes() {
      const values: ProjectRuntime[] = [];
      for (const binding of await listBindings()) values.push(await runtimeFor(binding));
      return values;
    },
    async archiveChat(bindingId: string, threadId: string, descendantThreadIds?: string[]) { await registryCall(store => store.archiveChat({ bindingId, threadId, descendantThreadIds })); },
    async describe(bindingId: string, thread: NativeThread) {
      for (;;) {
        const metadata = await registryCall(store => store.chatMetadataSnapshot());
        const binding = await currentBinding(bindingId);
        if ((await registryCall(store => store.snapshot())).revision !== metadata.revision) continue;
        const title = await readChatTitle(await runtimeFor(binding), thread);
        if ((await registryCall(store => store.snapshot())).revision !== metadata.revision) continue;
        return describeChat(binding, thread, title, metadata.entries.find(entry => entry.bindingId === bindingId && entry.threadId === thread.id));
      }
    },
    async setChatPinned(input: { chatId: string; pinned: boolean; beforeChatId?: string | null }) {
      if (!input.pinned && Object.hasOwn(input, 'beforeChatId')) throw new ORPCError('BAD_REQUEST', { message: 'Unpin does not accept a target chat.' });
      for (;;) {
        const revision = (await registryCall(store => store.snapshot())).revision;
        const current = await resolveThreadRoute(input.chatId);
        let before: { bindingId: string; threadId: string } | null | undefined;
        if (input.beforeChatId !== undefined && input.beforeChatId !== null) {
          const target = await resolveThreadRoute(input.beforeChatId);
          before = { bindingId: target.binding.id, threadId: target.thread.id };
        } else if (input.beforeChatId === null) before = null;
        // An ancestor may be archived while resolving the other reorder target.
        // Fence the combined reads before the existing atomic registry write.
        if ((await registryCall(store => store.snapshot())).revision !== revision) continue;
        await registryCall(store => store.setChatPinned({ bindingId: current.binding.id, threadId: current.thread.id, pinned: input.pinned, ...(before !== undefined ? { before } : {}) }));
        return;
      }
    },
    async setChatNotifications(input: { chatId: string; enabled: boolean }) {
      const current = await resolveThreadRoute(input.chatId);
      await registryCall(store => store.setChatNotifications({ bindingId: current.binding.id, threadId: current.thread.id, enabled: input.enabled }));
    },
    async defaultsRuntime() { return runtimeFor(await executionBinding(null)); },
    async listDirectories(input: { path?: string }) { return listProjectDirectories({ home, ...input }); },
    async createProject(input: { createKey: string; path: string }) {
      const path = (await listProjectDirectories({ home, path: input.path })).path;
      return registryCall(store => store.createProject({ createKey: input.createKey, name: basename(path), roots: [path] }));
    },
    async updateProject(input: { projectId: string; patch: ProjectPatch }) {
      const patch = { ...input.patch };
      if (patch.roots !== undefined) patch.roots = await canonicalRoots(patch.roots);
      return registryCall(store => store.updateProject({ id: input.projectId, patch }));
    },
    async deleteProject(input: { projectId: string }) { await registryCall(store => store.deleteProject({ id: input.projectId })); },
    async moveProjectBefore(input: { projectId: string; beforeId: string | null }) { await registryCall(store => store.moveProjectBefore({ id: input.projectId, beforeId: input.beforeId })); },
    async dispose() {
      const loaded = await Promise.allSettled(runtimes.values());
      const results = await Promise.allSettled(loaded.filter((result): result is PromiseFulfilledResult<ProjectRuntime> => result.status === 'fulfilled').map(result => result.value.dispose()));
      if (pendingRegistry) await pendingRegistry.then(store => store.close(), () => {});
      runtimes.clear();
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
