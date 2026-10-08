import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { loadServerConfig } from '../../src/server-config.js';
import { createProjectRuntime, type ProjectRuntime } from '../../src/runtime.js';
import { createChatService } from '../../src/chat-service.js';
import { createChatRouter } from '../../src/chat-router.js';
import { serveRouter } from '../../src/server.js';
import { lastUserText, startModelFixture } from './model-server.js';

// Test-only executable: disposable root required; never reads real credentials.
const root = process.argv[2];
const port = Number(process.argv[3]);
if (!root || !Number.isInteger(port)) throw new Error('Fixture requires a disposable root and port');
const profile = activateProfile(resolveProfile(join(resolve(root), 'profile')));
const directoryHome = await realpath(resolve(root));
const projectPath = join(directoryHome, 'project');
await mkdir(projectPath, { recursive: true });
await writeFile(join(projectPath, 'marker.txt'), 'BROWSER_TOOL_MARKER');
await writeFile(join(directoryHome, 'marker.txt'), 'BROWSER_TOOL_MARKER');
await mkdir(join(directoryHome, 'added-project'), { recursive: true });
await mkdir(join(directoryHome, 'changed-root'), { recursive: true });
const model = await startModelFixture(request => {
  if (request.model === 'judge') return { text: JSON.stringify({ decision: 'done', reason: 'Browser goal complete' }) };
  if (!request.stream) return { text: 'Browser test chat' };
  const user = lastUserText(request);
  if (JSON.stringify(request.messages).includes('HISTORY_NEW_ARRIVAL')) return { text: 'HISTORY_REPLY' };
  if (user.includes('READ_MARKER') && request.messages.at(-1)?.role !== 'tool') {
    const tool = request.tools?.find(tool => tool.function.name === 'view');
    if (!tool) throw new Error('Native view tool missing');
    return { toolCalls: [{ name: tool.function.name, arguments: { path: 'marker.txt' } }] };
  }
  if (user.includes('READ_MARKER') && !JSON.stringify(request.messages.at(-1)).includes('BROWSER_TOOL_MARKER')) throw new Error('Native tool did not return the marker contents');
  return { text: `fixture:${user}` };
});
// Judge prompts include transcript text; only hold the main chat request.
model.holdNext('HOLD_STOP', 'chat');
model.holdNext('HOLD_RESTART', 'chat');
await writeFile(profile.settingsPath, JSON.stringify({
  lsp: false,
  models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/judge' },
  customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fixture', models: ['chat', 'judge'] }],
  observability: { enabled: false },
}));
const runtimes: ProjectRuntime[] = [];
const service = createChatService({
  profile, directoryHome, ...await loadServerConfig(profile, [projectPath]),
  runtimeFactory: async options => { const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] }); runtimes.push(runtime); return runtime; },
});
if (process.argv[4] === 'history' && !(await service.listChats()).chats.length) {
  const catalog = await service.listChats();
  const chat = await service.createChat({ projectId: catalog.projects[0].id });
  await service.renameChat({ chatId: chat.id, title: 'History paging fixture' });
  const runtime = runtimes[0];
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id });
  if (!thread) throw new Error('Missing seeded native history thread');
  const store = await runtime.storage.getStore('memory');
  if (!store) throw new Error('Missing seeded native history storage');
  await store.saveMessages({ messages: Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, threadId: chat.id, resourceId: thread.resourceId,
    role: 'user' as const, createdAt: new Date(Date.now() - 100_000 + i * 1000), content: { format: 2 as const, parts: [{ type: 'text' as const, text: `HISTORY_ROW_${i}` }] } })) });
}
const server = await serveRouter(createChatRouter(service), port);
console.log(`BROWSER_FIXTURE_READY ${server.url}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    await server.close();
    await service.dispose();
    await model.close();
  })().then(() => process.exit(0), () => process.exit(1));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
