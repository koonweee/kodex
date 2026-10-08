import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createChatService } from '../src/chat-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function writeSkill(cwd: string, name: string, body: string, userInvocable = true) {
  const path = join(cwd, '.agents', 'skills', name); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Actual service fixture ${name}.\nuser-invocable: ${userInvocable}\n---\n\n${body}\n`);
  return { name, path };
}

test('typed HTTP skill submission uses native preparation, rejects invalid selections before signals and refreshes persisted display metadata', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-skill-service-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const cwd = join(root, 'project'), peerCwd = join(root, 'foreign-project'); await mkdir(cwd); await mkdir(peerCwd);
  await writeSkill(cwd, 'review', 'FIRST_SERVICE_SKILL_BODY');
  const hidden = await writeSkill(cwd, 'model-only', 'HIDDEN_SERVICE_SKILL_BODY', false);
  const foreign = await writeSkill(peerCwd, 'foreign', 'FOREIGN_SERVICE_SKILL_BODY');
  const fixture = await startModelFixture(request => ({ text: `SKILL_SERVICE_RESULT:${lastUserText(request).split('\n')[0]}` }));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }] }));
  const producers = new Map<string, ReturnType<typeof deferred>>();
  let runtime!: ProjectRuntime, signalCalls = 0;
  const service = createChatService({ profile, instanceId: 'skill-service-proof', directoryHome: cwd,
    projects: [{ id: 'project', name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async input => {
      const mounted = await createProjectRuntime({ ...input, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      if (input.runtimeRoot === join(root, 'runtime')) runtime = mounted;
      mounted.controller.onSessionCreated(session => {
        const send = session.sendSignal.bind(session);
        t.mock.method(session, 'sendSignal', (...args: Parameters<typeof send>) => { signalCalls++; return send(...args); });
      });
      const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
      const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
      // Test-only producer passthrough joins native persistence before disposal.
      t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
        const result = register(...args); if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred()); return result;
      });
      t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
        unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
      });
      return mounted;
    },
  });
  const server = await serveRouter(createChatRouter(service), 0);
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  t.after(async () => { await settled(); await server.close(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const first = client(), second = client();
  const catalog = await first.listSkills({ projectId: 'project' });
  assert.deepEqual(catalog.skills.map(skill => skill.name), ['review']);
  const { name, path } = catalog.skills[0]!;
  const selected = { name, path };
  assert.equal(signalCalls, 0); assert.equal(fixture.requests.length, 0);
  const chat = await first.createChat({ projectId: 'project' });
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  async function submit(input: Parameters<RouterClient<ChatRouter>['send']>[0]) {
    const ended = deferred();
    const off = session!.subscribe(event => { if (event.type === 'agent_end') ended.resolve(); });
    try { await first.send(input); await ended.promise; await settled(); } finally { off(); }
  }
  const text = 'Use $review', mention = { ...selected, start: 4, end: 11 };
  await submit({ chatId: chat.id, text, skills: [selected], skillMentions: [mention] });
  const initial = fixture.requests.find(request => lastUserText(request).startsWith(text)); assert.ok(initial);
  assert.equal(lastUserText(initial), 'Use $review\n\n<skill name="review">\nFIRST_SERVICE_SKILL_BODY\n</skill>');
  assert.equal(JSON.stringify(initial.messages).includes('HIDDEN_SERVICE_SKILL_BODY'), false);
  assert.equal(JSON.stringify(initial.messages).includes('FOREIGN_SERVICE_SKILL_BODY'), false);
  const snapshot = await second.openChat({ chatId: chat.id });
  const user = snapshot.messages.find(message => {
    const metadata = (message.content.metadata?.signal as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    return metadata?.kodexSkillInput !== undefined;
  }); assert.ok(user);
  assert.deepEqual((user.content.metadata?.signal as { metadata: Record<string, unknown> }).metadata.kodexSkillInput,
    { text, skills: [selected], mentions: [mention] });
  const mountedHidden = (await session.getWorkspace()!.skills!.list()).find(skill => skill.name === hidden.name);
  assert.ok(mountedHidden); hidden.path = mountedHidden.path;
  assert.equal(mountedHidden['user-invocable'], false, 'the rejected hidden reference is an actual native skill in this workspace');
  const signalsBefore = signalCalls, requestsBefore = fixture.requests.length, messagesBefore = snapshot.messages.length;
  for (const skills of [[{ name: 'missing', path: join(cwd, '.agents', 'skills', 'missing') }], [hidden], [foreign],
    [{ ...selected, name: 'wrong-name' }], [selected, { ...selected, name: 'wrong-name' }]]) {
    await assert.rejects(second.send({ chatId: chat.id, text: 'INVALID_SELECTION', skills }), { code: 'BAD_REQUEST' });
    assert.equal(signalCalls, signalsBefore); assert.equal(fixture.requests.length, requestsBefore);
  }
  await assert.rejects(second.send({ chatId: chat.id, text, skills: [selected], skillMentions: [{ ...mention, end: 100 }] }), { code: 'BAD_REQUEST' });
  assert.equal(signalCalls, signalsBefore); assert.equal(fixture.requests.length, requestsBefore);
  assert.equal((await second.openChat({ chatId: chat.id })).messages.length, messagesBefore);

  await writeSkill(cwd, 'review', 'UPDATED_SERVICE_SKILL_BODY with </skill> inside');
  const added = await writeSkill(cwd, 'new-skill', 'NEW_SERVICE_SKILL');
  assert.ok((await second.listSkills({ chatId: chat.id })).skills.some(skill => skill.name === added.name));
  await submit({ chatId: chat.id, text: 'FOLLOWUP_WITH_RETAINED_SELECTION', skills: [selected] });
  const refreshed = fixture.requests.find(request => lastUserText(request).startsWith('FOLLOWUP_WITH_RETAINED_SELECTION')); assert.ok(refreshed);
  assert.equal(lastUserText(refreshed), 'FOLLOWUP_WITH_RETAINED_SELECTION\n\n<skill name="review">\nUPDATED_SERVICE_SKILL_BODY with &lt;/skill&gt; inside\n</skill>');
  const refreshedSnapshot = await second.openChat({ chatId: chat.id });
  const displayed = refreshedSnapshot.messages.flatMap(message => {
    const input = ((message.content.metadata?.signal as { metadata?: Record<string, unknown> } | undefined)?.metadata?.kodexSkillInput);
    return input ? [input] : [];
  });
  assert.deepEqual(displayed, [{ text, skills: [selected], mentions: [mention] },
    { text: 'FOLLOWUP_WITH_RETAINED_SELECTION', skills: [selected], mentions: [] }], 'native identities survive when the display text no longer contains a mention token');
  assert.equal(signalCalls, signalsBefore + 1);
});
