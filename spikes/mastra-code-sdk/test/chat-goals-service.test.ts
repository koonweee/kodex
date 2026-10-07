import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createChatService, type ChatSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

test('native goal changes converge across two RPC clients and restart without waking paused edits', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-goal-service-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const path = join(root, 'project'); await mkdir(path);
  const fixture = await startModelFixture(() => ({ text: 'Unexpected goal execution' }));
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-key', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
  const make = () => createChatService({ profile, instanceId: 'goals', projects: [{ id: 'project', name: 'Project', path, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: options => createProjectRuntime({ ...options, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] }) });
  let service = make();
  const server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const first = client(), second = client();
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server.close(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  const chat = await first.createChat({ projectId: 'project' });
  await assert.rejects(first.updateGoal({ chatId: chat.id, patch: {} }), { code: 'BAD_REQUEST' });
  await assert.rejects(first.updateGoal({ chatId: chat.id, patch: { objective: '  ' } }), { code: 'BAD_REQUEST' });
  const watch = await second.watchChat({ chatId: chat.id }, { signal: abort.signal });
  await watch.next(); assert.equal((await second.openChat({ chatId: chat.id })).goal, null);
  async function until(predicate: (snapshot: ChatSnapshot) => boolean) {
    for (;;) { const next = await watch.next(); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
  }
  await first.updateGoal({ chatId: chat.id, patch: { objective: 'Original objective', status: 'paused' } });
  const original = (await until(snapshot => snapshot.goal?.objective === 'Original objective')).goal!;
  assert.equal(original.status, 'paused');
  await second.updateGoal({ chatId: chat.id, patch: { objective: 'Replacement objective' } });
  const replaced = await until(snapshot => snapshot.goal?.objective === 'Replacement objective');
  assert.equal(replaced.goal?.status, 'paused');
  assert.notEqual(replaced.goal?.id, original.id);
  assert.equal(replaced.goal?.evaluationsUsed, 0);
  assert.equal(replaced.display.isRunning, false);
  assert.equal((await first.openChat({ chatId: chat.id })).goal?.id, replaced.goal?.id);
  await first.clearGoal({ chatId: chat.id });
  await until(snapshot => snapshot.goal === null);
  await second.updateGoal({ chatId: chat.id, patch: { objective: 'Replacement objective', status: 'paused' } });
  const retained = await until(snapshot => snapshot.goal?.objective === 'Replacement objective');
  abort.abort(); await server.close(); await service.dispose();
  service = make();
  const reopened = await service.openChat({ chatId: chat.id });
  assert.equal(reopened.goal?.id, retained.goal?.id);
  assert.equal(reopened.goal?.status, 'paused');
  await service.clearGoal({ chatId: chat.id });
  assert.equal((await service.openChat({ chatId: chat.id })).goal, null);
  assert.equal(fixture.requests.length, 0, 'paused edits never start model work');
});
