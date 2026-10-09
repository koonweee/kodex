import { installFilesystemAccess } from './filesystem-access.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MastraCodeConfig, MountedMastraCode } from '@mastra/code-sdk';
import type { Mastra } from '@mastra/core/mastra';
import type { Session } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { assertProfileActive, type SpikeProfile } from './profile.js';
import { createChatGptAffinityProcessor } from './chatgpt-affinity.js';
import { createChatFastProcessor } from './chat-fast.js';
import { createHostModelGateways } from './model-gateways.js';
import { createRuntimeMcp } from './runtime-mcp.js';

export interface ProjectRuntimeOptions {
  projectPath: string;
  runtimeRoot: string;
  profile: SpikeProfile;
  modes?: MastraCodeConfig['modes'];
  extraTools?: MastraCodeConfig['extraTools'];
  subagents?: MastraCodeConfig['subagents'];
  disableMcp?: boolean;
  schedules?: NonNullable<ConstructorParameters<typeof Mastra>[0]>['schedules'];
  workflows?: NonNullable<ConstructorParameters<typeof Mastra>[0]>['workflows'];
}

// Host callers name their resource explicitly so concurrent setup has one owner.
export type SessionOptions = NonNullable<Parameters<MountedMastraCode['controller']['createSession']>[0]> & { resourceId: string };
export type NativeSession = Session<MastraCodeState>;

/** One native CodeSDK controller per project, sharing the process-start profile. */
export async function createProjectRuntime(options: ProjectRuntimeOptions) {
  assertProfileActive(options.profile);
  const projectPath = path.resolve(options.projectPath);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  // Profile activation precedes runtime imports and any SDK global initialization.
  const { prepareAgentControllerMount } = await import('@mastra/code-sdk');
  const { Mastra } = await import('@mastra/core/mastra');
  const { createRequestScopedCredentialStore } = await import('@mastra/code-sdk/agents/model');
  const { resolveCredentialStore } = await import('@mastra/code-sdk/agents/credential-resolver');
  const { getGlobalAuthStorage } = await import('@mastra/code-sdk/agents/mastracode-gateway');
  const affinity = createChatGptAffinityProcessor({
    isNativeCodexModel: ({ model, requestContext }) => {
      if (typeof model !== 'object' || model === null || !('provider' in model) || model.provider !== 'openai.responses') return false;
      // Reuse native request/account selection. OAuth and API-key models share
      // the same provider name; provider metadata alone cannot scope this header.
      const credentials = createRequestScopedCredentialStore(resolveCredentialStore(requestContext) ?? getGlobalAuthStorage(), requestContext);
      return credentials.get('openai-codex')?.type === 'oauth';
    },
  });
  const prepared = await prepareAgentControllerMount({
    cwd: projectPath,
    homeDir: options.profile.homeDir,
    settingsPath: options.profile.settingsPath,
    configDir: '.kodex-mastra-spike',
    storage: {
      backend: 'libsql',
      url: `file:${path.join(runtimeRoot, 'gateway.db')}`,
      vectorUrl: `file:${path.join(runtimeRoot, 'vectors.db')}`,
      isRemote: false,
    },
    omScope: 'thread',
    initialState: { sandboxAllowedPaths: [path.parse(projectPath).root], yolo: true, skipGlobalInstructions: true, homeDir: options.profile.homeDir },
    inputProcessors: [affinity, createChatFastProcessor()],
    disableEnvFile: true,
    disableGithubSignals: true,
    disableMcp: options.disableMcp ?? true,
    disabledTools: ['request_access'],
    disableHooks: true,
    disablePlugins: true,
    crossAgentSignals: false,
    scheduleTools: false,
    intervalHandlers: [],
    ...(options.modes && { modes: options.modes }),
    ...(options.extraTools && { extraTools: options.extraTools }),
    ...(options.subagents && { subagents: options.subagents }),
  });
  const gateways = await createHostModelGateways(options.profile.settingsPath, prepared.base.authStorage);
  const mastra = new Mastra({ ...prepared.mastraArgs, gateways,
    ...(options.workflows && { workflows: { ...prepared.mastraArgs.workflows, ...options.workflows } }),
    ...(options.schedules && { schedules: options.schedules }),
  });
  await prepared.finalize();
  const base = { ...prepared.base, mastra };
  const stopFilesystemAccess = installFilesystemAccess(base.controller, projectPath);
  const mcp = base.mcpManager ? createRuntimeMcp(base.mcpManager) : undefined;
  const sessions = new Map<string, { resourceId: string; scope?: string; session: NativeSession; releasingThreadId?: string | null }>();
  const creatingSessions = new Map<string, Promise<NativeSession>>();
  const releasingSessions = new Map<string, Promise<void>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const retired = () => new Error('Project runtime is disposed');
  function quiesce(session: NativeSession) {
    const threadId = session.thread.getId();
    if (threadId) session.machinery.getAgent().abortThreadStream({
      threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true,
    });
    session.abort();
  }

  async function createSession(input: SessionOptions, initialize?: (session: NativeSession, assertActive: () => void) => Promise<void>): Promise<NativeSession> {
    if (disposed) throw retired();
    const scope = input.scope, key = JSON.stringify([input.resourceId, scope ?? null]);
    const pending = creatingSessions.get(key);
    if (pending) {
      const session = await pending;
      if (disposed) throw retired();
      const releasing = releasingSessions.get(key);
      if (releasing) {
        await releasing;
        return createSession(input, initialize);
      }
      // Native createSession can select another thread on the same resource.
      // Preserve that behavior after setup; never return the wrong binding.
      if (input.threadId && session.thread.getId() !== input.threadId) return createSession(input, initialize);
      return session;
    }
    const creating = (async () => {
      const session = await base.controller.createSession({ ...input, tags: { ...input.tags, projectPath } });
      const tracked = { resourceId: session.identity.getResourceId(), scope, session };
      sessions.set(key, tracked);
      if (disposed) { quiesce(session); throw retired(); }
      const threadId = session.thread.getId(), abortGeneration = session.run.getAbortGeneration();
      const assertActive = () => {
        if (disposed || sessions.get(key) !== tracked || releasingSessions.has(key)
          || session.thread.getId() !== threadId || session.run.getAbortGeneration() !== abortGeneration) {
          throw new Error('Session setup was interrupted');
        }
      };
      try {
        // Initializers await configuration and input acceptance, never a model
        // run. They must recheck before initiating work after an awaited step.
        assertActive();
        if (initialize) await initialize(session, assertActive);
        assertActive();
        return session;
      } catch (error) {
        // Keep failed setup hidden until native cleanup finishes. Retirement
        // may already own this binding; never delete a replacement Session.
        if (initialize && !disposed && sessions.get(key) === tracked && session.thread.getId() === threadId) {
          quiesce(session);
          await releaseSession({ resourceId: tracked.resourceId, scope });
        }
        throw error;
      }
    })();
    creatingSessions.set(key, creating);
    try { return await creating; }
    finally { if (creatingSessions.get(key) === creating) creatingSessions.delete(key); }
  }

  async function releaseSession(input: { resourceId: string; scope?: string }): Promise<void> {
      // Retirement owns all remaining bindings once admissions close. Native
      // deleteSession does not join another deletion of the same resource.
      if (disposed) return;
      const key = JSON.stringify([input.resourceId, input.scope ?? null]);
      const existing = releasingSessions.get(key);
      if (existing) return existing;
      const tracked = sessions.get(key);
      if (tracked) tracked.releasingThreadId = tracked.session.thread.getId();
      const releasing = (async () => {
        try { await base.controller.deleteSession(input); }
        finally {
          // Native deletion drops registration even if lock release fails. Keep
          // tracking only when that same Session still owns the native resource.
          if (sessions.get(key) === tracked && await base.controller.getSessionByResource(input.resourceId, input.scope) !== tracked?.session) sessions.delete(key);
        }
      })();
      releasingSessions.set(key, releasing);
      try { await releasing; }
      finally { if (releasingSessions.get(key) === releasing) releasingSessions.delete(key); }
    }

  return {
    ...base,
    projectPath,
    runtimeRoot,
    mcp,
    createSession,
    // Enumerate only bindings admitted through this runtime. Native controller
    // lookups need a known scope; no scope naming convention is assumed here.
    sessionsForThread(input: { resourceId: string; threadId: string }) {
      return [...sessions.entries()].filter(([key, tracked]) => {
        if (tracked.resourceId !== input.resourceId || tracked.session.identity.getResourceId() !== input.resourceId) return false;
        const threadId = tracked.session.thread.getId();
        return threadId === input.threadId || threadId === null && releasingSessions.has(key) && tracked.releasingThreadId === input.threadId;
      }).map(([, tracked]) => ({ resourceId: tracked.resourceId, scope: tracked.scope, session: tracked.session }));
    },
    releaseSession,
    // Stop every parent wrapper before any child cancellation can wake it. This
    // prevents newly triggered preparation; native APIs provide no general join
    // for preparation already underway or detached title/snapshot writes.
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      stopFilesystemAccess();
      disposal = (async () => {
        // This complete first pass is synchronous, before any settlement await
        // or manager cancellation can publish to another still-open parent.
        for (const input of sessions.values()) quiesce(input.session);
        // Close MCP reload admission immediately; native initialization is not
        // joined during retirement. The backend entrypoint owns final exit.
        const mcpDisposal = mcp?.dispose();
        // Observe rejection now while session/storage cleanup is still awaited;
        // the original promise remains authoritative at the later await.
        void mcpDisposal?.catch(() => {});
        base.threadScheduler.stop();
        base.stopPluginSignalProviders();
        // Admissions were closed above. Late native creations are tracked and
        // quiesced before rejecting; failures do not skip existing-session cleanup.
        await Promise.allSettled([...creatingSessions.values()]);
        for (const input of sessions.values()) quiesce(input.session);
        // Cancel native background work before retirement deletes remaining bindings.
        await base.mastra.backgroundTaskManager?.shutdown();
        // A native duplicate delete returns immediately, so retirement must
        // join releases admitted before it took ownership of the bindings.
        await Promise.allSettled([...releasingSessions.values()]);
        for (const input of sessions.values()) {
          const memory = await input.session.machinery.getAgent().getMemory({ requestContext: await input.session.machinery.buildRequestContext() });
          if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
          await base.controller.deleteSession({ resourceId: input.resourceId, scope: input.scope });
        }
        sessions.clear();
        await mcpDisposal;
        await base.mastra.shutdown();
        await base.storageMaintenance.closeStorage?.();
      })();
      return disposal;
    },
  };
}

export type ProjectRuntime = Awaited<ReturnType<typeof createProjectRuntime>>;
