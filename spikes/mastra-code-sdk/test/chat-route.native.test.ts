import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { createChatService } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';

test('metadata route resolves native descendants across peers and restart without mounting sessions', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-route-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null }, lsp: false, observability: { enabled: false } }));
  const runtimes: ProjectRuntime[] = [];
  let mounts = 0;
  const make = () => createChatService({ profile, instanceId: 'routes', directoryHome: root,
    runtimeFactory: async options => {
      const runtime = await createProjectRuntime({ ...options, subagents: [] });
      const create = runtime.createSession.bind(runtime);
      t.mock.method(runtime, 'createSession', (...args: Parameters<typeof create>) => { mounts++; return create(...args); });
      runtimes.push(runtime); return runtime;
    } });
  let service = make();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  try {
    await service.listModels({ projectId: null });
    const runtime = runtimes[0]!;
    const store = await runtime.storage.getStore('memory'); assert.ok(store);
    const now = new Date();
    const save = (id: string, resourceId: string, metadata: Record<string, unknown>) => store.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now, metadata } });
    await save('parent', 'parent-resource', { projectPath: root });
    await save('child', 'child-resource', { projectPath: root, kodexChild: '1', parentThreadId: 'parent', parentResourceId: 'parent-resource', parentSessionScope: '', parentTaskId: 'task' });
    await save('fork', 'child-resource', { forkedSubagent: true, parentThreadId: 'child' });
    await save('foreign', 'foreign-resource', { projectPath: root, kodexChild: '1', parentThreadId: 'parent', parentResourceId: 'wrong', parentSessionScope: '', parentTaskId: 'foreign-task' });
    const verify = async () => {
      const first = client(), second = client();
      assert.equal((await first.readChatRoute({ chatId: 'parent' })).kind, 'ordinary');
      for (const [id, kind, parentThreadId] of [['child', 'child', 'parent'], ['fork', 'fork', 'child']] as const) {
        const route = await first.readChatRoute({ chatId: id });
        assert.equal(route.kind, kind);
        assert.equal(route.rootChatId, 'parent'); assert.equal(route.parentThreadId, parentThreadId);
        assert.equal(route.chat.id, id); assert.equal(route.chat.cwd, root);
        assert.deepEqual(await second.readChatRoute({ chatId: id }), route);
      }
      await assert.rejects(first.readChatRoute({ chatId: 'foreign' }));
      await assert.rejects(first.readChatRoute({ chatId: 'missing' }));
      assert.deepEqual((await first.listChats()).chats.map(chat => chat.id), ['parent']);
      assert.equal(mounts, 0);
    };
    await verify();
    await server.close(); await service.dispose();
    service = make(); server = await serveRouter(createChatRouter(service), 0);
    await verify();
    // A native title-preview read must remain inside the archive fence,
    // rather than revive a descendant after its ordinary root was retired.
    const current = runtimes.at(-1)!;
    const memory = await current.storage.getStore('memory'); assert.ok(memory);
    const fork = await current.controller.queryThreadById({ threadId: 'fork' }); assert.ok(fork);
    await memory.saveThread({ thread: { ...fork, title: '' } });
    const query = current.controller.queryThreadMessages.bind(current.controller);
    let hold = true, entered!: () => void, release!: () => void;
    const enteredRead = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(current.controller, 'queryThreadMessages', async (...args: Parameters<typeof query>) => {
      const rows = await query(...args);
      if (hold) { hold = false; entered(); await released; }
      return rows;
    });
    const overlapping = client().readChatRoute({ chatId: 'fork' });
    const rejected = assert.rejects(overlapping);
    try {
      await enteredRead;
      await service.archiveChat({ chatId: 'parent' });
    } finally { release(); }
    await rejected;
    for (const chatId of ['parent', 'child', 'fork']) await assert.rejects(client().readChatRoute({ chatId }));
    assert.equal(mounts, 0);
  } finally { await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
