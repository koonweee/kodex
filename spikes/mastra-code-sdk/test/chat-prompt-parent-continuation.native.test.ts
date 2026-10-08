import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { createChatService } from '../src/chat-service.js';
import { createChildTools } from '../src/child-tools.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

let profile: SpikeProfile, profileRoot: string;
before(async () => { profileRoot = await mkdtemp(join(tmpdir(), 'kodex-parent-continuation-profile-')); profile = activateProfile(resolveProfile(profileRoot)); });
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

for (const yolo of [true, false]) test(`native service child completion after parent question uses native synthesis under yolo=${yolo}`, { timeout: 25_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-parent-prompt-continuation-'));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  let runtime!: ProjectRuntime, parent: NativeSession | undefined, child: NativeSession | undefined;
  let childTaskId = '', parentReplySeen = false, parentResultSeen = false, delegating = false, completionDelivered = false;
  const parentParked = gate(), parentAnswered = gate(), parentContinued = gate(), childParked = gate(), parentResult = gate(), completionPublished = gate(), completionParentEnded = gate();
  const trace: unknown[] = [];
  const approvalResumes: string[] = [];
  const suspended = new Set<string>(), producers = new Map<string, ReturnType<typeof gate>>();
  const fixture = await startModelFixture(request => {
    const serialized = JSON.stringify(request.messages), last = lastUserText(request);
    trace.push({ request: fixture.requests.length, last });
    if (serialized.includes('DELEGATE_AFTER_QUESTION') && serialized.includes('CHILD_AFTER_QUESTION_RESULT')) { parentResultSeen = true; return { text: 'PARENT_AFTER_QUESTION_RESULT' }; }
    if (last.includes('CHILD_AFTER_QUESTION')) {
      if (serialized.includes('User answered: CHILD_ANSWER')) return { text: 'CHILD_AFTER_QUESTION_RESULT' };
      return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Child evidence?' }, id: 'child-question' }] };
    }
    if (last.includes('DELEGATE_AFTER_QUESTION')) {
      if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'))) { parentReplySeen = true; return { text: 'PARENT_CONTINUES_AFTER_QUESTION' }; }
      return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'CHILD_AFTER_QUESTION: ask for evidence.' }, id: 'parent-delegate' }] };
    }
    if (serialized.includes('User answered: PARENT_ANSWER')) { parentReplySeen = true; return { text: 'PARENT_QUESTION_RESULT' }; }
    return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Parent evidence?' }, id: 'parent-question' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, backgroundTools: { enabled: true }, observability: { enabled: false },
    models: { observerModelOverride: null, reflectorModelOverride: null }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local', models: ['chat'] }] }));
  const service = createChatService({ profile, instanceId: 'parent-prompt-continuation', directoryHome: projectPath,
    projects: [{ id: 'project', name: 'Project', path: projectPath, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async input => {
      runtime = await createProjectRuntime({ ...input, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: createChildTools({ getRuntime: () => runtime }) });
      const nativeCreate = runtime.createSession.bind(runtime);
      runtime.createSession = async input => {
        const session = await nativeCreate(input);
        await session.state.set({ yolo });
        for (const toolName of ['ask_user', 'delegate_child']) await session.permissions.setForTool({ toolName, policy: 'allow' });
        return session;
      };
      const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra), unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
      t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
        const result = register(...args); if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate()); return result;
      });
      t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => { unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release(); });
      runtime.controller.onSessionCreated(session => {
        if (session.getTags().kodexChild === '1') child = session;
        else {
          parent = session;
          const agent = session.machinery.getAgent(), nativeResume = agent.resumeStream.bind(agent);
          t.mock.method(agent, 'resumeStream', (...[data, options]: Parameters<typeof nativeResume>) => { if (options?.toolCallId === 'parent-delegate') approvalResumes.push(options.runId ?? ''); trace.push({ resume: { runId: options?.runId, toolCallId: options?.toolCallId, untilIdle: options?.untilIdle, thread: options?.memory?.thread } }); return nativeResume(data, options); });
        }
        session.subscribe(event => {
          trace.push({ session: session.getTags().kodexChild === '1' ? 'child' : 'parent', runId: session.getCurrentRunId(), event });
          const runId = session.getCurrentRunId();
          if (event.type === 'agent_start' && runId) suspended.delete(runId);
          if (event.type === 'tool_suspended') { if (runId) suspended.add(runId); if (session === parent) parentParked.release(); else childParked.release(); }
          if (session === parent && event.type === 'agent_end' && event.reason === 'complete') {
            if (completionDelivered) completionParentEnded.release();
            if (parentResultSeen) parentResult.release();
            else if (parentReplySeen && delegating) parentContinued.release();
            else if (parentReplySeen) parentAnswered.release();
          }
        });
      });
      runtime.backgroundCompletionEvents?.subscribe(event => { trace.push({ completion: event }); if (event.status === 'completed') { completionDelivered = true; completionPublished.release(); } });
      return runtime;
    },
  });
  async function joinProducers() {
    let size = -1;
    while (size !== producers.size) { size = producers.size; await Promise.all([...producers].map(([runId, done]) => suspended.has(runId) ? undefined : done.promise)); }
  }
  t.diagnostic(`Native parent continuation trace: ${join(root, 'trace.json')}`);
  t.after(async () => { await service.dispose(); await joinProducers(); await fixture.close(); await writeFile(join(root, 'trace.json'), JSON.stringify({ yolo, childTaskId, parentResultSeen, requests: fixture.requests, trace }, null, 2)); for (const directory of ['profile', 'project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true }); });
  const chat = await service.createChat({ projectId: 'project' });
  await service.send({ chatId: chat.id, text: 'PARENT_QUESTION' }); await parentParked.promise;
  const prompt = (await service.openChat({ chatId: chat.id })).prompts[0]!; assert.ok(prompt.target);
  await service.respondPrompt({ chatId: chat.id, kind: 'question', target: prompt.target, answer: 'PARENT_ANSWER' });
  await parentAnswered.promise; await joinProducers(); assert.ok(parent); assert.equal(parent.run.isRunning(), false, 'delegate submission starts from a finished parent resume');
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  delegating = true;
  await service.send({ chatId: chat.id, text: 'DELEGATE_AFTER_QUESTION' });
  await childParked.promise; assert.ok(child);
  const relation = child.getTags(); childTaskId = String(relation.parentTaskId);
  await parentContinued.promise;
  assert.equal((await manager.getTask(childTaskId))?.status, 'running');
  const childPrompt = (await service.listSubagents({ chatId: chat.id })).childPrompts[0]!.prompt; assert.ok(childPrompt.target);
  await service.respondPrompt({ chatId: chat.id, kind: 'question', target: childPrompt.target, answer: 'CHILD_ANSWER' });
  await completionPublished.promise;
  if (yolo) await parentResult.promise;
  // In strict mode the pinned SDK closes a native result-delivery segment
  // without a model request. Observe that public terminal before absence checks.
  await completionParentEnded.promise;
  await joinProducers();
  const task = await manager.getTask(childTaskId); assert.equal(task?.status, 'completed');
  assert.ok(JSON.stringify(task.result).includes('CHILD_AFTER_QUESTION_RESULT'), 'both modes persist the real child terminal result');
  assert.equal(approvalResumes.length > 0, !yolo, 'strict explicit allow uses a native approval resume while default permissive dispatch stays inline');
  assert.equal(parentResultSeen, yolo, yolo
    ? 'default permissive parent receives native automatic synthesis'
    : 'native explicit-allow approval resume replaces the tool result without automatic parent synthesis');
  const memory = await parent.machinery.getAgent().getMemory({ requestContext: await parent.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
  assert.ok(JSON.stringify(await parent.thread.listActiveMessages()).includes('CHILD_AFTER_QUESTION_RESULT'), 'the parent native transcript receives the canonical result in both modes');
  assert.equal(await runtime.controller.getSessionByResource(child.identity.getResourceId()), child, 'completed child binding is retained in both modes');
});
