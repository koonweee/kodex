import { parseArgs } from 'node:util';
import { activateProfile, resolveProfile } from './profile.js';
import { requireChatGptAuth } from './auth.js';
import { createProjectRuntime } from './runtime.js';
import { loadServerConfig } from './server-config.js';
import { createChatService } from './chat-service.js';
import { createChatRouter } from './chat-router.js';
import { serveRouter } from './server.js';

const { values } = parseArgs({ options: {
  project: { type: 'string', multiple: true },
  profile: { type: 'string' },
  port: { type: 'string', default: '8789' },
  model: { type: 'string', default: process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol' },
} });
if (!values.project?.length) throw new Error('Usage: npm run serve -- --project /absolute/project [--project /another/project] [--profile /dedicated/root] [--port 8789]');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
const profile = activateProfile(resolveProfile(values.profile));
requireChatGptAuth(profile);
const config = await loadServerConfig(profile, values.project);
// Use the native settings API in the dedicated profile. Preserve existing model
// choices; seed fresh memory/judge settings with the authenticated chat provider.
const { loadSettings, saveSettings } = await import('@mastra/code-sdk/onboarding/settings');
const settings = loadSettings(profile.settingsPath);
settings.models.observerModelOverride ??= values.model;
settings.models.reflectorModelOverride ??= values.model;
settings.models.goalJudgeModel ??= values.model;
settings.models.goalMaxTurns = Number.MAX_SAFE_INTEGER;
saveSettings(settings, profile.settingsPath);
const service = createChatService({
  profile, ...config,
  runtimeFactory: options => createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: values.model, metadata: { default: true } }] }),
});
const server = await serveRouter(createChatRouter(service), port);
console.log(`Kodex Mastra spike: ${server.url} (localhost only)`);
console.log(`Profile: ${profile.root}; projects: ${config.projects.map(project => project.path).join(', ')}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void (async () => { await server.close(); await service.dispose(); })().catch(() => {
    console.error('Mastra shutdown failed. Native trailing-write limitations remain under evaluation.');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
