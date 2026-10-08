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
import { startModelFixture } from './fixtures/model-server.js';

test('parent RPC routes only its live descendant prompts and peers converge after the native reply', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-prompt-routing-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  let requests = 0;
  const fixture = await startModelFixture(request => {
    requests++;
    if (JSON.stringify(request.messages).includes('User answered: ROUTED_ANSWER')) return { text: 'ROUTED_RESULT' };
    return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which child evidence?' }, id: 'routed-question' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local', models: ['chat'] }] }));
  let runtime!: ProjectRuntime;
  const service = createChatService({ profile, instanceId: 'prompts', directoryHome: projectPath,
    projects: [{ id: 'prompts', name: 'Prompts', path: projectPath, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async input => {
      const mounted = await createProjectRuntime({ ...input, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      if (input.runtimeRoot === join(root, 'runtime')) runtime = mounted;
      return mounted;
    } });
  const server = await serveRouter(createChatRouter(service), 0), abort = new AbortController();
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  t.after(async () => { abort.abort(); await server.close(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const first = client(), second = client();
  const parent = await first.createChat({ projectId: 'prompts' }), other = await second.createChat({ projectId: 'prompts' });
  const parentRow = await runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(parentRow);
  const observer = await second.watchSubagents({ chatId: parent.id }, { signal: abort.signal }); await observer.next();
  const child = await runtime.createSession({ threadId: 'prompt-child', resourceId: 'prompt-child-resource', tags: {
    kodexChild: '1', parentThreadId: parent.id, parentResourceId: parentRow.resourceId, parentSessionScope: '', parentTaskId: 'prompt-task',
  } });
  await child.thread.rename({ title: 'Evidence child', pin: true });
  await child.sendMessage({ content: 'Ask which evidence.', untilIdle: false });
  assert.equal(child.suspensions.hasPending(), true);
  const inventory = await first.listSubagents({ chatId: parent.id });
  assert.equal(inventory.childPrompts.length, 1);
  const prompt = inventory.childPrompts[0]!.prompt; assert.equal(prompt.kind, 'question');
  assert.ok(prompt.target);
  assert.equal(inventory.childPrompts[0]!.ownerTitle, 'Evidence child');
  assert.deepEqual((await second.listSubagents({ chatId: other.id })).childPrompts, []);
  const response = { kind: 'question' as const, target: prompt.target, answer: 'ROUTED_ANSWER' };
  await assert.rejects(second.respondPrompt({ chatId: other.id, ...response }), { code: 'NOT_FOUND' });
  await assert.rejects(first.respondPrompt({ chatId: parent.id, ...response, target: { ...prompt.target, sessionId: 'stale-session' } }), { code: 'CONFLICT' });
  assert.equal(requests, 1);
  let finished!: () => void;
  const ended = new Promise<void>(resolve => { finished = resolve; });
  const off = child.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') finished(); }); t.after(off);
  assert.deepEqual(await first.respondPrompt({ chatId: parent.id, ...response }), { accepted: true });
  await ended;
  let peer = inventory;
  while (peer.childPrompts.length) { const next = await observer.next(); assert.equal(next.done, false); peer = next.value; }
  assert.deepEqual(peer.childPrompts, []);
  assert.equal(requests, 2);
  await assert.rejects(second.respondPrompt({ chatId: parent.id, ...response }), { code: 'CONFLICT' });
  await observer.return();
  const memory = await child.machinery.getAgent().getMemory({ requestContext: await child.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
  const read = await second.openSubagent({ chatId: parent.id, kind: 'child', id: 'prompt-child' });
  assert.ok(JSON.stringify(read.messages).includes('ROUTED_RESULT'));
  await first.archiveChat({ chatId: parent.id });
  await assert.rejects(second.respondPrompt({ chatId: parent.id, ...response }), { code: 'CONFLICT' });
  assert.equal(requests, 2, 'stale and archived replies never create another native run');
});
