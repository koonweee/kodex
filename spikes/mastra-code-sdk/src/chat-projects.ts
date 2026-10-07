import { basename } from 'node:path';
import { homedir } from 'node:os';
import { ORPCError } from '@orpc/server';
import { createProjectRuntime, type ProjectRuntime } from './runtime.js';
import { openProductRegistry, ProductRegistryError, type ProductRegistry, type ProjectSeed, type ProjectPatch, type RuntimeBinding } from './product-registry.js';
import { listProjectDirectories } from './project-directories.js';
import type { SpikeProfile } from './profile.js';

export type NativeThread = NonNullable<Awaited<ReturnType<ProjectRuntime['controller']['queryThreadById']>>>;
export interface Chat { id: string; projectId: string | null; title: string; cwd: string }
export interface ChatProjectOptions {
  profile: SpikeProfile;
  projects?: ProjectSeed[];
  directoryHome?: string;
  registryFactory?: () => Promise<ProductRegistry>;
  runtimeFactory?: typeof createProjectRuntime;
}
const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });
export const ownsThread = (binding: RuntimeBinding, thread: NativeThread) => thread.metadata?.projectPath === binding.cwd && thread.metadata?.forkedSubagent !== true;
export const describeChat = (binding: RuntimeBinding, thread: NativeThread): Chat => ({ id: thread.id, projectId: binding.projectId, title: thread.title?.trim() || 'New chat', cwd: binding.cwd });

/** Product membership is read from the registry. Native runtimes remain attached
 * to immutable binding identities and cwd, including detached standalone chats.
 */
export function createChatProjects(options: ChatProjectOptions, assertActive: () => void) {
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
      pending = (options.runtimeFactory ?? createProjectRuntime)({ projectPath: binding.cwd, runtimeRoot: binding.runtimeRoot, profile: options.profile });
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
      const bindings = await listBindings();
      const chats: Chat[] = [];
      for (const binding of bindings) {
        const runtime = await runtimeFor(binding);
        const threads = await runtime.controller.queryThreads({ metadata: { projectPath: binding.cwd } });
        for (const thread of threads) if (ownsThread(binding, thread)) chats.push(describeChat(binding, thread));
      }
      assertActive();
      if ((await registryCall(store => store.snapshot())).revision === snapshot.revision) return { projects: snapshot.projects, chats };
    }
  }
  async function findThread(chatId: string) {
    for (const binding of await listBindings()) {
      const runtime = await runtimeFor(binding);
      const thread = await runtime.controller.queryThreadById({ threadId: chatId });
      if (thread && ownsThread(binding, thread)) return { binding, runtime, thread };
    }
    throw missing();
  }
  async function canonicalRoots(paths: string[]) {
    return Promise.all(paths.map(async path => (await listProjectDirectories({ home, path })).path));
  }
  return {
    runtimeFor, executionBinding, currentBinding, inventory, findThread,
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
