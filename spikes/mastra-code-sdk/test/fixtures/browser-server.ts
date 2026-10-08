import { getLocalPlansDir, getSuggestedPlanRelativePath } from '@mastra/code-sdk/utils/plans';
import { createTool } from '@mastra/core/tools';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { loadServerConfig } from '../../src/server-config.js';
import { createProjectRuntime, type ProjectRuntime } from '../../src/runtime.js';
import { createAsyncQuestionTools } from '../../src/async-question-tools.js';
import { createChildTools } from '../../src/child-tools.js';
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
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
await writeFile(join(projectPath, 'pixel.png'), png);
await writeFile(join(directoryHome, 'pixel.png'), png);
await mkdir(join(directoryHome, 'added-project'), { recursive: true });
await mkdir(join(directoryHome, 'changed-root'), { recursive: true });
const browserPlanPath = getSuggestedPlanRelativePath('browser-review');
const planPaths = [directoryHome, projectPath].map(base => join(base, browserPlanPath));
if (process.argv[4] === 'plans') {
  for (const base of [directoryHome, projectPath]) await mkdir(getLocalPlansDir(base), { recursive: true });
  for (const path of planPaths) await writeFile(path, '# Browser review\nInspect **native** evidence.');
  await writeFile(join(root, 'fixture-plan-paths.json'), JSON.stringify(planPaths));
}
const model = await startModelFixture(async request => {
  if (request.model === 'judge') return { text: JSON.stringify({ decision: 'done', reason: 'Browser goal complete' }) };
  if (!request.stream) return { text: 'Browser test chat' };
  const user = lastUserText(request);
  const serialized = JSON.stringify(request.messages);
  if (process.argv[4] === 'attachments') {
    const latest = request.messages.findLast(message => message.role === 'user');
    const imageUrls = Array.isArray(latest?.content) ? latest.content.flatMap(part =>
      typeof part === 'object' && part && part.type === 'image_url' ? [part.image_url?.url] : []) : [];
    if (imageUrls.length) {
      if (imageUrls.length !== 1 || imageUrls[0] !== `data:image/png;base64,${png.toString('base64')}`) throw new Error('Browser attachment image bytes did not reach the provider');
      return { text: `BROWSER_UPLOADED_IMAGE_RECEIVED:${user.trim() || 'image-only'}` };
    }
    if (user.includes('BROWSER_FILE_SEND')) {
      const reference = /- (\.kodex\/uploads\/[^\n]+\/notes\.txt)/.exec(user)?.[1];
      if (!reference) throw new Error('Browser generic file reference did not reach the provider');
      let contents: string | undefined;
      for (const cwd of [projectPath, directoryHome]) {
        try { contents = await readFile(join(cwd, reference), 'utf8'); break; } catch {}
      }
      if (contents !== 'BROWSER_GENERIC_FILE_BYTES') throw new Error('Browser generic file bytes were not saved in the bound working directory');
      return { text: 'BROWSER_FILE_REFERENCE_RECEIVED' };
    }
  }
  if (serialized.includes('BROWSER_DELEGATE_QUESTION') && serialized.includes('BROWSER_INTERACTIVE_CHILD_RESULT')) return { text: 'BROWSER_PARENT_INTERACTION_RESULT' };
  if (user.includes('BROWSER_NATIVE_PLAN')) {
    if (serialized.includes('Plan approved.')) return { text: 'BROWSER_NATIVE_PLAN_RESULT' };
    return { toolCalls: [{ name: 'submit_plan', arguments: { path: browserPlanPath }, id: 'native-plan' }] };
  }
  if (user.includes('BROWSER_INTERACTIVE_CHILD')) {
    if (serialized.includes('User answered: Alpha, Beta')) return { text: 'BROWSER_INTERACTIVE_CHILD_RESULT' };
    return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which child evidence?', options: [{ label: 'Alpha', description: 'First source' }, { label: 'Beta', description: 'Second source' }], selectionMode: 'multi_select' }, id: 'interactive-child-question' }] };
  }
  if (user.includes('BROWSER_DELEGATE_QUESTION')) {
    if (serialized.includes('BROWSER_INTERACTIVE_CHILD_RESULT')) return { text: 'BROWSER_PARENT_INTERACTION_RESULT' };
    if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'))) return { text: 'BROWSER_PARENT_WORK_CONTINUES' };
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'BROWSER_INTERACTIVE_CHILD: ask the user which sources to inspect.' }, id: 'interactive-delegate' }] };
  }
  if (user.includes('BROWSER_NATIVE_QUESTION')) {
    if (serialized.includes('User answered: Use repository evidence')) return { text: 'BROWSER_NATIVE_QUESTION_RESULT' };
    return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which evidence should I inspect?', options: [{ label: 'Use repository evidence' }, { label: 'Ask later' }] }, id: 'native-question' }] };
  }
  if (user.includes('BROWSER_NATIVE_APPROVAL')) {
    if (serialized.includes('BROWSER_TOOL_MARKER')) return { text: 'BROWSER_NATIVE_APPROVAL_RESULT' };
    return { toolCalls: [{ name: 'prompt_approval', arguments: {}, id: 'native-approval' }] };
  }
  if (user === 'Use native history') return { text: 'BROWSER_REPLY_CHOICE_RECEIVED' };
  if (user === 'Keep <this> & "that"') return { text: 'BROWSER_REPLY_TEXT_RECEIVED' };
  if (user.includes('BROWSER_ASK_ASYNC')) {
    if (request.messages.some(message => message.role === 'tool')) return { text: 'BROWSER_WORK_CONTINUED' };
    return { toolCalls: [{ name: 'request_user_input_async', arguments: { questions: [
      { title: 'Which **history** should I use?', options: ['Use native history', 'Inspect more first'] },
      { title: 'Any other constraints?', options: null },
    ] }, id: 'browser-async-question' }] };
  }
  if (user.includes('BROWSER_FRESH_CHILD')) {
    if (serialized.includes('BROWSER_TOOL_MARKER')) return { text: 'BROWSER_FRESH_RESULT' };
    return { toolCalls: [{ name: 'view', arguments: { path: 'marker.txt' }, id: 'fresh-child-view' }] };
  }
  if (serialized.includes('BROWSER_DELEGATE')) {
    if (serialized.includes('BROWSER_FRESH_RESULT')) return { text: 'BROWSER_DELEGATED_PARENT_RESULT' };
    if (request.messages.some(message => message.role === 'tool')) return { text: 'BROWSER_PARENT_WAITING' };
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'BROWSER_FRESH_CHILD: inspect marker.txt.' }, id: 'fresh-child-delegate' }] };
  }
  if (user.includes('BROWSER_CHILD_')) {
    const mode = user.includes('FORKED') ? 'FORKED' : 'DEFAULT';
    if (JSON.stringify(request.messages).includes('BROWSER_TOOL_MARKER')) return { text: `BROWSER_CHILD_RESULT_${mode}` };
    return { toolCalls: [{ name: 'view', arguments: { path: 'marker.txt' }, id: `child-view-${mode}` }] };
  }
  if (user.includes('BROWSER_PARENT_')) {
    const mode = user.includes('FORKED') ? 'FORKED' : 'DEFAULT';
    if (JSON.stringify(request.messages).includes(`BROWSER_CHILD_RESULT_${mode}`)) return { text: `BROWSER_PARENT_RESULT_${mode}` };
    return { toolCalls: [{ name: 'subagent', arguments: { agentType: 'explore', task: `BROWSER_CHILD_${mode}: inspect marker.txt.`, ...(mode === 'FORKED' ? { forked: true } : {}) }, id: `parent-child-${mode}` }] };
  }
  if (JSON.stringify(request.messages).includes('HISTORY_NEW_ARRIVAL')) return { text: 'HISTORY_REPLY' };
  if ((user.includes('REPLACE_MARKER') || user.includes('REPLACE_MISSING')) && request.messages.at(-1)?.role !== 'tool') {
    return { toolCalls: [{ name: 'string_replace_lsp', arguments: { path: 'marker.txt', old_string: user.includes('REPLACE_MISSING') ? 'ABSENT_STRING' : 'BROWSER_TOOL_MARKER', new_string: 'BROWSER_EDITED_MARKER' } }] };
  }
  if (user.includes('RUN_SHELL_FAILURE') && request.messages.at(-1)?.role !== 'tool') {
    return { toolCalls: [{ name: 'execute_command', arguments: { description: "Exercise native nonzero shell output", command: "printf 'NATIVE_SHELL_OUTPUT\\n'; exit 7" } }] };
  }
  if (user.includes('READ_IMAGE') && request.messages.at(-1)?.role !== 'tool') return { toolCalls: [{ name: 'view', arguments: { path: 'pixel.png' } }] };
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
  lsp: false, backgroundTools: { enabled: true },
  models: { subagentModels: { default: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/judge' },
  customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fixture', models: ['chat', 'judge'] }],
  observability: { enabled: false },
}));
const runtimes: ProjectRuntime[] = [];
const promptTools = ['prompts', 'approvals'].includes(process.argv[4] ?? '') ? { prompt_approval: createTool({
  id: 'prompt_approval', description: 'Test-only native approval gate.', requireApproval: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => readFile(join(projectPath, 'marker.txt'), 'utf8'),
}) } : {};
const service = createChatService({
  profile, directoryHome, ...await loadServerConfig(profile, [projectPath]),
  runtimeFactory: async options => {
    let runtime!: ProjectRuntime;
    runtime = await createProjectRuntime({ ...options, extraTools: { ...createChildTools({ getRuntime: () => runtime }), ...createAsyncQuestionTools(), ...promptTools },
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }, ...(process.argv[4] === 'plans' ? [{ id: 'plan', defaultModelId: 'fixture/chat' }] : [])] });
    if (process.argv[4] === 'approvals') {
      const create = runtime.createSession.bind(runtime);
      runtime.createSession = async input => {
        const session = await create(input);
        await session.state.set({ yolo: false });
        await session.permissions.setForTool({ toolName: 'prompt_approval', policy: 'ask' });
        for (const toolName of ['ask_user', 'delegate_child']) await session.permissions.setForTool({ toolName, policy: 'allow' });
        return session;
      };
    }
    if (process.argv[4] === 'plans') {
      const create = runtime.createSession.bind(runtime);
      runtime.createSession = async input => {
        const session = await create(input);
        await session.mode.switch({ modeId: 'plan' });
        return session;
      };
    }
    runtimes.push(runtime); return runtime;
  },
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
if (process.argv[4] === 'input-images' && !(await service.listChats()).chats.length) {
  const catalog = await service.listChats();
  const chat = await service.createChat({ projectId: catalog.projects[0].id });
  await service.renameChat({ chatId: chat.id, title: 'Native input image fixture' });
  const runtime = runtimes[0], thread = await runtime.controller.queryThreadById({ threadId: chat.id });
  if (!thread) throw new Error('Missing seeded native input image thread');
  const store = await runtime.storage.getStore('memory');
  if (!store) throw new Error('Missing seeded native image storage');
  // Actual native saved signal/file shape proven by chat-attachments.native.test.ts.
  // This is persisted history rendering, not browser submission or a mocked API.
  const file = (data: string, mimeType: string, filename: string) => ({ type: 'file' as const, data, mimeType, filename });
  const source = { threadId: chat.id, resourceId: thread.resourceId, role: 'signal' as const };
  await store.saveMessages({ messages: [
    { ...source, id: 'input-images-text', createdAt: new Date(Date.now() - 2000), content: { format: 2 as const,
      parts: [{ type: 'text' as const, text: 'Inspect this image <pixel> & preserve the text.' }, file(png.toString('base64'), 'image/png', 'pixel.png'),
        file('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'image/gif', 'motion.gif')],
      metadata: { signal: { id: 'input-images-text', type: 'user', metadata: { clientId: 'input-image-text-correlation' } } } } },
    { ...source, id: 'input-images-only', createdAt: new Date(Date.now() - 1000), content: { format: 2 as const,
      parts: [file(png.toString('base64'), 'image/png', 'only.png')],
      metadata: { signal: { id: 'input-images-only', type: 'user', metadata: { clientId: 'input-image-only-correlation' } } } } },
  ] });
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
