import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MastraCodeConfig, MountedMastraCode } from '@mastra/code-sdk';
import type { Mastra } from '@mastra/core/mastra';
import type { Session } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { assertProfileActive, type SpikeProfile } from './profile.js';
import { createChatGptAffinityProcessor } from './chatgpt-affinity.js';

export interface ProjectRuntimeOptions {
  projectPath: string;
  runtimeRoot: string;
  profile: SpikeProfile;
  modes?: MastraCodeConfig['modes'];
  extraTools?: MastraCodeConfig['extraTools'];
  subagents?: MastraCodeConfig['subagents'];
  disableMcp?: boolean;
  schedules?: NonNullable<ConstructorParameters<typeof Mastra>[0]>['schedules'];
}

export type SessionOptions = NonNullable<Parameters<MountedMastraCode['controller']['createSession']>[0]>;
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
    initialState: { yolo: true, skipGlobalInstructions: true, homeDir: options.profile.homeDir },
    inputProcessors: [affinity],
    disableEnvFile: true,
    disableGithubSignals: true,
    disableMcp: options.disableMcp ?? true,
    disableHooks: true,
    disablePlugins: true,
    crossAgentSignals: false,
    scheduleTools: false,
    intervalHandlers: [],
    ...(options.modes && { modes: options.modes }),
    ...(options.extraTools && { extraTools: options.extraTools }),
    ...(options.subagents && { subagents: options.subagents }),
  });
  const mastra = new Mastra({ ...prepared.mastraArgs, ...(options.schedules && { schedules: options.schedules }) });
  await prepared.finalize();
  const base = { ...prepared.base, mastra };
  const sessions = new Map<string, { resourceId: string; scope?: string; session: NativeSession }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  return {
    ...base,
    projectPath,
    runtimeRoot,
    async createSession(input: SessionOptions): Promise<NativeSession> {
      if (disposed) throw new Error('Project runtime is disposed');
      const session = await base.controller.createSession({
        ...input,
        tags: { ...input.tags, projectPath },
      });
      const resourceId = session.identity.getResourceId();
      sessions.set(JSON.stringify([resourceId, input.scope ?? null]), { resourceId, scope: input.scope, session });
      return session;
    },
    // Native shutdown closes storage but does not join detached title/snapshot writes.
    // This spike exercises native teardown; safe production retirement remains unproven.
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        base.threadScheduler.stop();
        base.stopPluginSignalProviders();
        for (const input of sessions.values()) {
          const memory = await input.session.machinery.getAgent().getMemory({ requestContext: await input.session.machinery.buildRequestContext() });
          if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
          await base.controller.deleteSession({ resourceId: input.resourceId, scope: input.scope });
        }
        sessions.clear();
        await base.mcpManager?.disconnect();
        await base.mastra.shutdown();
        await base.storageMaintenance.closeStorage?.();
      })();
      return disposal;
    },
  };
}

export type ProjectRuntime = Awaited<ReturnType<typeof createProjectRuntime>>;
