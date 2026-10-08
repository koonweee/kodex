import { readPushConfig } from './push-sender.js';
import { shutdownBackend } from './shutdown.js';
import { homedir } from 'node:os';
import { createTerminalService } from './terminal-service.js';
import { parseArgs } from 'node:util';
import { activateProfile, resolveProfile } from './profile.js';
import { requireChatGptAuth } from './auth.js';
import { createProjectRuntime, type ProjectRuntime } from './runtime.js';
import { createAsyncQuestionTools } from './async-question-tools.js';
import { createChildTools } from './child-tools.js';
import { createControlTools } from './control-tools.js';
import { createControlAutomationTools } from './control-automation-tools.js';
import { loadServerConfig } from './server-config.js';
import { createChatService, type ChatService } from './chat-service.js';
import { createGatewayRouter } from './gateway-router.js';
import { serveRouter } from './server.js';

const { values } = parseArgs({ options: {
  project: { type: 'string', multiple: true },
  profile: { type: 'string' },
  port: { type: 'string', default: '8789' },
  model: { type: 'string', default: process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol' },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
const profile = activateProfile(resolveProfile(values.profile));
requireChatGptAuth(profile);
const config = await loadServerConfig(profile, values.project ?? []);
// Use the native settings API in the dedicated profile. Preserve existing model
// choices; seed fresh memory/judge settings with the authenticated chat provider.
const { loadSettings, saveSettings } = await import('@mastra/code-sdk/onboarding/settings');
const settings = loadSettings(profile.settingsPath);
settings.models.observerModelOverride ??= values.model;
settings.models.reflectorModelOverride ??= values.model;
settings.models.goalJudgeModel ??= values.model;
settings.models.goalMaxTurns = Number.MAX_SAFE_INTEGER;
// Native task workers and completion delivery own fresh child delegation.
settings.backgroundTools.enabled = true;
saveSettings(settings, profile.settingsPath);
const service: ChatService = createChatService({
  profile, ...config, push: { config: readPushConfig(process.env) },
  runtimeFactory: async options => {
    let runtime!: ProjectRuntime;
    runtime = await createProjectRuntime({ ...options, disableMcp: false,
      extraTools: { ...createChildTools({ getRuntime: () => runtime }), ...createAsyncQuestionTools(),
        ...createControlTools({ getRuntime: () => runtime, getService: () => service }),
        ...createControlAutomationTools({ getRuntime: () => runtime, getService: () => service }) },
      modes: [{ id: 'build', defaultModelId: values.model, metadata: { default: true } }],
    });
    return runtime;
  },
});
await service.initializeAutomations();
await service.push();
const terminals = createTerminalService({ defaultCwd: homedir(), projectCwd: id => service.terminalProjectCwd(id) });
const server = await serveRouter(createGatewayRouter(service, terminals), port, service, terminals, { frontendDir: process.env.KODEX_FRONTEND_DIST });
console.log(`Kodex Mastra spike: ${server.url} (localhost only)`);
console.log(`Profile: ${profile.root}; projects: ${config.projects.map(project => project.path).join(', ')}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void shutdownBackend(server, terminals, service).catch(() => {
    console.error('Mastra shutdown failed. Native trailing-write limitations remain under evaluation.');
    process.exitCode = 1;
  }).finally(() => process.exit(process.exitCode ?? 0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
