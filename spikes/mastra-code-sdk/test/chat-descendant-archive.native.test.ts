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
import { openProductRegistry, type ChatMetadata, type ProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

test('archive includes pinned transitive native descendants and retains dormant history across peers and restart', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-descendant-archive-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const fixture = await startModelFixture();
  let runtime!: ProjectRuntime, registry!: ProductRegistry;
  let service: ReturnType<typeof createChatService> | undefined;
  let server: Awaited<ReturnType<typeof serveRouter>> | undefined;
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server?.close(); await service?.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  async function mount() {
    service = createChatService({ profile, instanceId: 'descendant-archive', directoryHome: projectPath,
      projects: [{ id: 'descendant-archive', name: 'Archive project', path: projectPath, runtimeRoot: join(root, 'runtime') }],
      registryFactory: async () => { registry = await openProductRegistry(profile, { standaloneCwd: projectPath }); return registry; },
      runtimeFactory: async input => {
        const mounted = await createProjectRuntime({ ...input,
          modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] });
        if (input.projectPath === projectPath && input.runtimeRoot === join(root, 'runtime')) runtime = mounted;
        return mounted;
      } });
    server = await serveRouter(createChatRouter(service), 0);
  }
  const client = (): RouterClient<ChatRouter> => { assert.ok(server); return createORPCClient(new RPCLink({ url: `${server.url}/rpc` })); };
  await mount();
  let first = client(), second = client();
  const parent = await first.createChat({ projectId: 'descendant-archive' });
  const other = await second.createChat({ projectId: 'descendant-archive' });
  const parentRow = await runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(parentRow);
  const otherRow = await runtime.controller.queryThreadById({ threadId: other.id }); assert.ok(otherRow);
  const binding = (await registry.listBindings()).find(row => row.projectId === 'descendant-archive'); assert.ok(binding);
  const store = await runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const rows = [
    { id: 'archive-direct-fork', resourceId: parentRow.resourceId, metadata: { forkedSubagent: true, parentThreadId: parent.id } },
    { id: 'archive-nested-fresh', resourceId: 'archive-nested-resource', metadata: {
      projectPath, kodexChild: '1', parentThreadId: 'archive-direct-fork', parentResourceId: parentRow.resourceId,
      parentSessionScope: '', parentTaskId: 'archive-nested-task',
    } },
    { id: 'archive-nested-fork', resourceId: 'archive-nested-resource', metadata: { forkedSubagent: true, parentThreadId: 'archive-nested-fresh' } },
    { id: 'archive-ordinary-fork', resourceId: parentRow.resourceId, metadata: { projectPath, parentThreadId: parent.id } },
    { id: 'archive-unrelated-fork', resourceId: otherRow.resourceId, metadata: { forkedSubagent: true, parentThreadId: other.id } },
    { id: 'archive-invalid-bridge', resourceId: 'invalid-resource', metadata: { forkedSubagent: true, parentThreadId: parent.id } },
    { id: 'archive-invalid-leaf', resourceId: 'invalid-resource', metadata: { forkedSubagent: true, parentThreadId: 'archive-invalid-bridge' } },
  ];
  for (const row of rows) await store.saveThread({ thread: { ...row, title: row.id, createdAt: now, updatedAt: now } });
  const descendants = rows.slice(0, 3);
  const retainedMessages = descendants.map(row => ({ id: `${row.id}-retained`, threadId: row.id, resourceId: row.resourceId,
    role: 'assistant' as const, createdAt: now, content: { format: 2 as const, parts: [{ type: 'text' as const, text: `RETAINED_${row.id}` }] } }));
  await store.saveMessages({ messages: retainedMessages });
  // Product pin membership is separate from native title pinning. Archive must
  // include pinned descendants and preserve their existing metadata tuple.
  for (const threadId of [parent.id, 'archive-direct-fork', 'archive-nested-fresh', other.id]) {
    await registry.setChatPinned({ bindingId: binding.id, threadId, pinned: true });
  }
  await registry.setChatNotifications({ bindingId: binding.id, threadId: 'archive-nested-fresh', enabled: false });
  const before = await registry.chatMetadataSnapshot();
  const beforeById = new Map(before.entries.map(row => [row.threadId, row]));
  assert.equal(typeof beforeById.get('archive-direct-fork')?.pinPosition, 'number');
  assert.equal(typeof beforeById.get('archive-nested-fresh')?.pinPosition, 'number');
  let activations = 0;
  const offCreated = runtime.controller.onSessionCreated(() => { activations++; }); t.after(offCreated);
  const catalog = await second.watchCatalog(undefined, { signal: abort.signal }); await catalog.next();
  assert.deepEqual(await first.archiveChat({ chatId: parent.id }), { accepted: true });
  const changed = await catalog.next(); assert.equal(changed.done, false);
  assert.ok(changed.value!.archivedChatIds.includes(parent.id));
  assert.ok(changed.value!.chats.some(row => row.id === other.id));
  assert.ok(changed.value!.pinnedChatIds.includes(other.id));
  await catalog.return();
  const after = await registry.chatMetadataSnapshot();
  const archivedIds = after.entries.filter(row => row.bindingId === binding.id && row.archived).map(row => row.threadId).sort();
  assert.deepEqual(archivedIds, [parent.id, ...descendants.map(row => row.id)].sort());
  for (const threadId of ['archive-direct-fork', 'archive-nested-fresh']) {
    const updated: ChatMetadata = after.entries.find(row => row.bindingId === binding.id && row.threadId === threadId)!;
    assert.deepEqual(updated, { ...beforeById.get(threadId), archived: true }, 'pin and notification metadata survive descendant archival');
  }
  assert.deepEqual(after.entries.find(row => row.threadId === other.id), beforeById.get(other.id), 'unrelated metadata is unchanged');
  assert.ok(after.entries.every(row => row.bindingId === binding.id), 'descendant metadata stays under its root binding');
  assert.equal(await runtime.controller.getSessionByResource(parentRow.resourceId), undefined);
  assert.equal(await runtime.controller.getSessionByResource(otherRow.resourceId) !== undefined, true, 'unrelated parent binding survives');
  await assert.rejects(second.openChat({ chatId: parent.id }), { code: 'CONFLICT' });
  const inventory = await second.listSubagents({ chatId: parent.id });
  assert.deepEqual(inventory.forks.map(row => row.id).sort(), ['archive-direct-fork', 'archive-nested-fork']);
  assert.deepEqual(inventory.children.map(row => row.id), ['archive-nested-fresh']);
  for (const row of descendants) {
    const kind = row.id === 'archive-nested-fresh' ? 'child' : 'fork';
    const read = await second.openSubagent({ chatId: parent.id, kind, id: row.id });
    assert.deepEqual(read.messages.map(message => message.id), [`${row.id}-retained`]);
    assert.ok(JSON.stringify(read.messages).includes(`RETAINED_${row.id}`));
    assert.equal(read.display, undefined);
  }
  assert.equal(activations, 0, 'archive and read-only inspection never activate stored descendants');
  assert.equal(fixture.requests.length, 0);
  offCreated();
  await server!.close(); server = undefined; await service!.dispose(); service = undefined;
  await mount(); first = client(); second = client();
  const restartedCatalog = await first.listChats();
  assert.ok(restartedCatalog.archivedChatIds.includes(parent.id));
  const restartedMetadata = await registry.chatMetadataSnapshot();
  assert.deepEqual(restartedMetadata.entries, after.entries, 'descendant archive and pin metadata survive restart');
  let restartActivations = 0;
  const offRestarted = runtime.controller.onSessionCreated(() => { restartActivations++; }); t.after(offRestarted);
  await assert.rejects(first.openChat({ chatId: parent.id }), { code: 'CONFLICT' });
  for (const row of descendants) {
    const read = await second.openSubagent({ chatId: parent.id, kind: row.id === 'archive-nested-fresh' ? 'child' : 'fork', id: row.id });
    assert.deepEqual(read.messages.map(message => message.id), [`${row.id}-retained`]);
    assert.equal(read.display, undefined);
    assert.equal(await runtime.controller.getSessionByResource(row.resourceId), undefined);
  }
  assert.equal(restartActivations, 0, 'restarted archived history stays dormant');
  assert.equal(fixture.requests.length, 0);
});
