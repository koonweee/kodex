import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { createChatService, type ChatService, type ChatSnapshot } from '../src/chat-service.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
let failureServer: ReturnType<typeof createServer>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-mastra-chat-service-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => ({ text: `fixture:${lastUserText(request)}` }));
  failureServer = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Deliberate local model failure', type: 'invalid_request_error', code: 'fixture_failure' } }));
  });
  failureServer.listen(0, '127.0.0.1');
  await once(failureServer, 'listening');
  const address = failureServer.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/chat' },
    customProviders: [
      { name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] },
      { name: 'failure', url: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-no-real-credential', models: ['bad'] },
    ],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => {
  await fixture?.close();
  failureServer?.closeAllConnections();
  if (failureServer) await new Promise<void>((resolve, reject) => failureServer.close(error => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup(name: string) {
  const projects = await Promise.all(['a', 'b'].map(async id => {
    const path = join(root, `${name}-project-${id}`);
    await mkdir(path);
    return { id, name: `Project ${id}`, path, runtimeRoot: join(root, `${name}-runtime-${id}`) };
  }));
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, instanceId: 'fixture-instance', projects, registryFactory: () => openProductRegistry(resolveProfile(join(root, `${name}-product-profile`))), runtimeFactory: async options => {
    const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    runtimes.push(runtime);
    return runtime;
  } });
  return { projects, runtimes, makeService };
}
async function serve(service: ChatService) {
  const server = await serveRouter(createChatRouter(service), 0);
  return { client: (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` })), close: server.close };
}
async function nativeSession(runtimes: ProjectRuntime[], chatId: string) {
  for (const runtime of runtimes) {
    const thread = await runtime.controller.queryThreadById({ threadId: chatId });
    if (thread) {
      const session = await runtime.controller.getSessionByResource(thread.resourceId);
      assert.ok(session);
      return session;
    }
  }
  throw new Error('Fixture chat session was not found');
}
function hasUserInput(snapshot: ChatSnapshot, text: string) {
  return snapshot.messages.some(message => {
    const signal = message.content.metadata?.signal;
    const userAuthored = message.role === 'user' || (message.role === 'signal' && typeof signal === 'object' && signal !== null && 'type' in signal && (signal.type === 'user' || signal.type === 'user-message'));
    return userAuthored && message.content.parts.some(part => part.type === 'text' && part.text === text);
  });
}
async function until(iterator: AsyncIterator<ChatSnapshot>, predicate: (snapshot: ChatSnapshot) => boolean) {
  const timeout = AbortSignal.timeout(15_000);
  for (;;) {
    let rejectTimeout!: () => void;
    const expired = new Promise<never>((_, reject) => { rejectTimeout = () => reject(new Error('Chat snapshot timeout')); });
    timeout.throwIfAborted();
    timeout.addEventListener('abort', rejectTimeout, { once: true });
    try {
      const next = await Promise.race([iterator.next(), expired]);
      assert.equal(next.done, false);
      if (predicate(next.value!)) return next.value!;
    } finally { timeout.removeEventListener('abort', rejectTimeout); }
  }
}

test('two RPC clients share native chats, Send acceptance, Queue, Stop and reconnect history', { timeout: 60_000 }, async t => {
  const { makeService, projects, runtimes } = await setup('shared');
  const service = makeService();
  const server = await serve(service);
  const first = server.client();
  const second = server.client();
  const abortA = new AbortController();
  const abortB = new AbortController();
  const catalogAbort = new AbortController();
  t.after(async () => { abortA.abort(); abortB.abort(); catalogAbort.abort(); await server.close(); await service.dispose(); });
  assert.deepEqual(await first.info(), { instanceId: 'fixture-instance' });
  assert.deepEqual((await first.listChats()).chats, []);
  const catalog = await second.watchCatalog(undefined, { signal: catalogAbort.signal });
  const initialCatalogResult = await catalog.next();
  assert.equal(initialCatalogResult.done, false);
  const initialCatalog = initialCatalogResult.value;
  assert.deepEqual(initialCatalog.chats, []);
  const chat = await first.createChat({ projectId: 'a' });
  const other = await second.createChat({ projectId: 'a' });
  await (await nativeSession(runtimes, chat.id)).thread.rename({ title: 'Shared fixture chat' });
  assert.notEqual(chat.id, other.id);
  assert.equal(chat.cwd, projects[0]!.path);
  const updatedCatalogResult = await catalog.next();
  assert.equal(updatedCatalogResult.done, false);
  const updatedCatalog = updatedCatalogResult.value;
  assert.ok(updatedCatalog.revision > initialCatalog.revision);
  assert.ok(updatedCatalog.chats.some(entry => entry.id === chat.id), 'peer discovers a chat it did not create');
  const [openedA, openedB] = await Promise.all([first.openChat({ chatId: chat.id }), second.openChat({ chatId: chat.id })]);
  assert.equal(openedA.epoch, openedB.epoch, 'tabs share one native session projection');
  const a = await first.watchChat({ chatId: chat.id }, { signal: abortA.signal });
  const b = await second.watchChat({ chatId: chat.id }, { signal: abortB.signal });
  await a.next(); await b.next();
  const hold = fixture.holdNext('TWO_CLIENT_HOLD');
  assert.deepEqual(await first.send({ chatId: chat.id, text: 'TWO_CLIENT_HOLD' }), { accepted: true }, 'Send acknowledges native acceptance before completion');
  await hold.reached;
  await until(b, snapshot => snapshot.display.isRunning && Boolean(snapshot.display.currentMessage));
  abortA.abort();
  await a.return?.().catch(() => undefined);
  assert.equal((await second.openChat({ chatId: chat.id })).display.isRunning, true, 'closing one observer leaves native work running');
  const queuedPeer = await second.queue({ chatId: chat.id, text: 'PEER_QUEUE' });
  assert.equal(queuedPeer.accepted, true);
  assert.equal(queuedPeer.outcome, 'applied');
  assert.equal(queuedPeer.snapshot.rows[0]?.input.text, 'PEER_QUEUE');
  await until(b, snapshot => snapshot.display.queuedFollowUps === 1);
  assert.deepEqual(await second.stop({ chatId: chat.id }), { accepted: true });
  hold.release();
  const finished = await until(b, snapshot => !snapshot.display.isRunning && snapshot.display.queuedFollowUps === 0 && JSON.stringify(snapshot.messages).includes('fixture:PEER_QUEUE'));
  assert.ok(hasUserInput(finished, 'TWO_CLIENT_HOLD'), 'Send persists the exact human input independently of assistant output');
  assert.ok(hasUserInput(finished, 'PEER_QUEUE'), 'followUp persists the exact queued human input');
  const reconnect = await first.openChat({ chatId: chat.id });
  assert.equal(reconnect.epoch, finished.epoch);
  assert.deepEqual(reconnect.messages, finished.messages);
  assert.deepEqual((await second.openChat({ chatId: other.id })).messages, [], 'another chat in the same native database stays separate');
  assert.equal(runtimes.length, 2, 'project runtimes are shared across all client operations');
});

test('native persisted inventory and completed history reopen after service restart without activating a run', { timeout: 60_000 }, async () => {
  const { makeService, runtimes } = await setup('restart');
  const initial = makeService();
  let reopened: ChatService | undefined;
  try {
    const chat = await initial.createChat({ projectId: 'b' });
    await (await nativeSession(runtimes, chat.id)).thread.rename({ title: 'Restart fixture chat' });
    const watch = initial.watchChat({ chatId: chat.id });
    const epoch = (await watch.next()).value!.epoch;
    await initial.send({ chatId: chat.id, text: 'PERSISTED_CHAT' });
    const completed = await until(watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('fixture:PERSISTED_CHAT'));
    await watch.return(undefined);
    await initial.dispose();
    const requestsBeforeRestart = fixture.requests.length;
    reopened = makeService();
    const inventory = (await reopened.listChats()).chats;
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]?.id, chat.id);
    const restored = await reopened.openChat({ chatId: chat.id });
    assert.notEqual(restored.epoch, epoch, 'a new service has new projection coverage');
    assert.deepEqual(restored.messages, completed.messages);
    assert.ok(hasUserInput(restored, 'PERSISTED_CHAT'), 'the exact native human input survives restart (Session persists user signals, not plain user rows)');
    assert.equal(restored.display.isRunning, false);
    assert.equal(restored.display.queuedFollowUps, 0);
    assert.equal(fixture.requests.length, requestsBeforeRestart, 'list/open do not invoke the model');
    const runtime = runtimes.at(-1)!;
    const native = await runtime.controller.queryThreadById({ threadId: chat.id });
    assert.ok(native?.resourceId, 'inventory comes from native thread rows');
  } finally { await initial.dispose(); await reopened?.dispose(); }
});

test('unknown IDs and malformed RPC input do not create native conversations', { timeout: 60_000 }, async t => {
  const { makeService } = await setup('validation');
  const service = makeService();
  const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const client = server.client();
  await assert.rejects(client.createChat({ projectId: 'unknown' }), { code: 'NOT_FOUND' });
  await assert.rejects(client.openChat({ chatId: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(client.send({ chatId: 'missing', text: 'unowned' }), { code: 'NOT_FOUND' });
  await assert.rejects(client.stop({ chatId: 'missing' }), { code: 'NOT_FOUND' });
  const chat = await client.createChat({ projectId: 'a' });
  await assert.rejects(client.send({ chatId: chat.id, text: '   ' }), { code: 'BAD_REQUEST' });
  await assert.rejects(client.send({ chatId: chat.id, text: 42 } as unknown as { chatId: string; text: string }), { code: 'BAD_REQUEST' });
  await assert.rejects(client.send({ chatId: chat.id, text: 'input', resourceId: 'browser-selected-resource' } as { chatId: string; text: string }), { code: 'BAD_REQUEST' });
  assert.equal((await client.listChats()).chats.length, 1);
  assert.deepEqual((await client.openChat({ chatId: chat.id })).messages, []);
});

test('idle Queue acknowledges its native run without waiting and failures remain visible on reconnect', { timeout: 60_000 }, async t => {
  const { makeService, runtimes } = await setup('errors');
  const service = makeService();
  t.after(() => service.dispose());
  const chat = await service.createChat({ projectId: 'a' });
  const native = await nativeSession(runtimes, chat.id);
  await native.thread.rename({ title: 'Error fixture chat' });
  const watch = service.watchChat({ chatId: chat.id });
  await watch.next();
  const hold = fixture.holdNext('IDLE_QUEUE');
  await service.queue({ chatId: chat.id, text: 'IDLE_QUEUE' });
  await hold.reached;
  assert.equal((await service.openChat({ chatId: chat.id })).display.isRunning, true);
  hold.release();
  const idleCompleted = await until(watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('IDLE_QUEUE'));
  assert.ok(hasUserInput(idleCompleted, 'IDLE_QUEUE'), 'idle Queue persists the exact native human input');
  await native.model.switch('failure/bad');
  await service.send({ chatId: chat.id, text: 'FAIL_RESPONSE' });
  const failed = await until(watch, snapshot => !snapshot.display.isRunning && snapshot.error !== null);
  const reconnect = await service.openChat({ chatId: chat.id });
  assert.equal(reconnect.error, failed.error);
  assert.ok(reconnect.error, 'native model failure is retained in the process-local projection');
  await watch.return(undefined);
});


test('Send during an active native run is admitted without browser lifecycle routing', { timeout: 60_000 }, async t => {
  const { makeService, runtimes } = await setup('active-send');
  const service = makeService();
  t.after(() => service.dispose());
  const chat = await service.createChat({ projectId: 'a' });
  await (await nativeSession(runtimes, chat.id)).thread.rename({ title: 'Active Send fixture chat' });
  const watch = service.watchChat({ chatId: chat.id });
  await watch.next();
  const hold = fixture.holdNext('ACTIVE_NATIVE_HOLD');
  await service.send({ chatId: chat.id, text: 'ACTIVE_NATIVE_HOLD' });
  await hold.reached;
  assert.deepEqual(await service.send({ chatId: chat.id, text: 'ACTIVE_NATIVE_INPUT' }), { accepted: true });
  assert.equal((await service.openChat({ chatId: chat.id })).display.isRunning, true);
  hold.release();
  const completed = await until(watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('ACTIVE_NATIVE_INPUT'));
  assert.ok(hasUserInput(completed, 'ACTIVE_NATIVE_HOLD'));
  assert.ok(hasUserInput(completed, 'ACTIVE_NATIVE_INPUT'), 'an admitted active-run interjection remains a native user-authored signal');
  await watch.return(undefined);
});


test('archive retires native work, fences competing admissions and tells two RPC clients without deleting dormant history', { timeout: 60_000 }, async t => {
  const { makeService, runtimes } = await setup('archive');
  const service = makeService();
  const server = await serve(service);
  const first = server.client(), second = server.client();
  const catalogAbort = new AbortController(), watchAbort = new AbortController();
  let reopened: ChatService | undefined;
  let releasePreparation = () => {};
  const hold = fixture.holdNext('ARCHIVE_SERVICE_HELD');
  t.after(async () => { releasePreparation(); hold.release(); catalogAbort.abort(); watchAbort.abort(); await server.close(); await service.dispose(); await reopened?.dispose(); });
  const chat = await first.createChat({ projectId: 'a' });
  const peer = await second.createChat({ projectId: 'a' });
  await first.renameChat({ chatId: chat.id, title: 'Retained archived title' });
  const watcher = await second.watchChat({ chatId: chat.id }, { signal: watchAbort.signal });
  await watcher.next();
  await first.send({ chatId: chat.id, text: 'ARCHIVE_SERVICE_HISTORY' });
  const completed = await until(watcher, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('fixture:ARCHIVE_SERVICE_HISTORY'));
  const native = await nativeSession(runtimes, chat.id);
  const agent = native.machinery.getAgent();
  const target = { threadId: chat.id, resourceId: native.identity.getResourceId() };
  const memory = await agent.getMemory({ requestContext: await native.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
  await first.send({ chatId: chat.id, text: 'ARCHIVE_SERVICE_HELD' }); await hold.reached;
  await second.queue({ chatId: chat.id, text: 'ARCHIVE_SERVICE_TRACKED' });
  const streamOptions = await native.machinery.buildStreamOptions({});
  const raw = agent.queueMessage('ARCHIVE_SERVICE_RAW', { ...target, ifIdle: { behavior: 'wake', streamOptions } });
  assert.equal((await raw.accepted).action, 'deliver');
  await first.setChatPinned({ chatId: chat.id, pinned: true });
  const catalog = await second.watchCatalog(undefined, { signal: catalogAbort.signal }); await catalog.next();

  // Hold only request-context preparation: retirement must fence new work and
  // wait for already-admitted input acceptance, never for model completion.
  const buildContext = native.machinery.buildRequestContext.bind(native.machinery);
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releasePreparation = release;
  const observation = t.mock.method(native.machinery, 'buildRequestContext', async (...args: Parameters<typeof native.machinery.buildRequestContext>) => {
    reached(); await held; return buildContext(...args);
  });
  const admitted = service.send({ chatId: chat.id, text: 'ARCHIVE_SERVICE_ADMITTED' });
  await entered;
  const retirement = service.archiveChat({ chatId: chat.id });
  void admitted.catch(() => {}); void retirement.catch(() => {});
  const competitors = [
    service.send({ chatId: chat.id, text: 'ARCHIVE_SERVICE_REJECTED' }),
    service.queue({ chatId: chat.id, text: 'ARCHIVE_SERVICE_REJECTED_QUEUE' }),
    service.renameChat({ chatId: chat.id, title: 'Stale rename' }),
    service.updateGoal({ chatId: chat.id, patch: { objective: 'Stale goal' } }),
    service.clearGoal({ chatId: chat.id }),
    service.updateChatSettings({ chatId: chat.id, patch: { fast: true } }),
    service.openChat({ chatId: chat.id }),
  ];
  for (const result of await Promise.allSettled(competitors)) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'CONFLICT');
  }
  observation.mock.restore(); release();
  assert.deepEqual(await admitted, { accepted: true });
  assert.deepEqual(await retirement, { accepted: true });
  assert.equal(native.run.isRunning(), false);
  const runtime = (await Promise.all(runtimes.map(async runtime => (await runtime.controller.queryThreadById({ threadId: chat.id })) ? runtime : undefined))).find(Boolean)!;
  assert.equal(await runtime.controller.getSessionByResource(target.resourceId), undefined);
  let archivedCatalog;
  for (;;) {
    const next = await catalog.next(); assert.equal(next.done, false);
    if (next.value!.archivedChatIds.includes(chat.id)) { archivedCatalog = next.value!; break; }
  }
  assert.ok(archivedCatalog.chats.some(row => row.id === peer.id));
  assert.ok(!archivedCatalog.chats.some(row => row.id === chat.id));
  assert.ok(!archivedCatalog.pinnedChatIds.includes(chat.id));
  await assert.rejects(second.openChat({ chatId: chat.id }), { code: 'CONFLICT' });
  await assert.rejects(second.watchChat({ chatId: chat.id }).then(iterator => iterator.next()), { code: 'CONFLICT' });
  assert.deepEqual(await first.archiveChat({ chatId: chat.id }), { accepted: true }, 'repeated archive stays dormant');
  const history = await runtime.controller.queryThreadMessages({ ...target, perPage: 40, orderBy: { field: 'createdAt', direction: 'ASC' } });
  for (const row of completed.messages) assert.ok(history.messages.some(message => message.id === row.id));
  assert.equal((await runtime.controller.queryThreadById({ threadId: chat.id }))!.title, 'Retained archived title');
  const requestsBeforeRestart = fixture.requests.length;
  catalogAbort.abort(); watchAbort.abort(); await server.close(); await service.dispose();
  reopened = makeService();
  const restored = await reopened.listChats();
  assert.ok(restored.archivedChatIds.includes(chat.id));
  assert.ok(restored.chats.some(row => row.id === peer.id));
  await assert.rejects(reopened.openChat({ chatId: chat.id }), { code: 'CONFLICT' });
  assert.equal(fixture.requests.length, requestsBeforeRestart, 'archived list/deep links do not wake canceled work');
  assert.ok(fixture.requests.every(request => !JSON.stringify(request.messages).includes('ARCHIVE_SERVICE_TRACKED') && !JSON.stringify(request.messages).includes('ARCHIVE_SERVICE_RAW')));
});

test('archive retries native deletion failure without retaining a cleared Session or waking history', { timeout: 60_000 }, async t => {
  const { makeService, runtimes } = await setup('archive-deletion-retry');
  const service = makeService(); t.after(() => service.dispose());
  const chat = await service.createChat({ projectId: 'a' });
  const native = await nativeSession(runtimes, chat.id);
  const resourceId = native.identity.getResourceId();
  const runtime = (await Promise.all(runtimes.map(async runtime => (await runtime.controller.queryThreadById({ threadId: chat.id })) ? runtime : undefined))).find(Boolean)!;
  const deleteSession = runtime.controller.deleteSession.bind(runtime.controller);
  const failDeletion = t.mock.method(runtime.controller, 'deleteSession', async (...args: Parameters<typeof runtime.controller.deleteSession>) => {
    await deleteSession(...args);
    throw new Error('Fixture: native deletion lost its lock-release acknowledgment');
  });
  await assert.rejects(service.archiveChat({ chatId: chat.id }));
  failDeletion.mock.restore();
  assert.equal(native.thread.getId(), null);
  assert.equal(await runtime.controller.getSessionByResource(resourceId), undefined);
  assert.ok(!(await service.listChats()).archivedChatIds.includes(chat.id), 'failed deletion is not an archive success');
  const requests = fixture.requests.length;
  assert.deepEqual(await service.archiveChat({ chatId: chat.id }), { accepted: true });
  assert.ok((await service.listChats()).archivedChatIds.includes(chat.id));
  assert.equal(fixture.requests.length, requests);
  // Disposal must not revisit the cleared Session in the runtime tracking map.
  await service.dispose();
});


test('native file upload resolves the retained chat root without activating dormant sessions', async t => {
  const { makeService, runtimes, projects } = await setup('uploads');
  const initial = makeService();
  const chat = await initial.createChat({ projectId: 'a' });
  await initial.dispose();
  const service = makeService();
  const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const client = server.client();
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(42);
  const saved = await client.uploadFile({ chatId: chat.id, file: new File([bytes], 'source notes.txt', { type: 'text/plain' }) });
  assert.equal(saved.fileName, 'source notes.txt');
  assert.equal(saved.sizeBytes, bytes.length);
  assert.equal(saved.absolutePath, join(await realpath(projects[0]!.path), saved.relativePath));
  assert.deepEqual(await readFile(saved.absolutePath), Buffer.from(bytes));
  const runtime = runtimes.at(-1)!;
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  assert.equal(await runtime.controller.getSessionByResource(thread.resourceId), undefined);
  await assert.rejects(client.uploadFile({ chatId: 'missing', file: new File(['content'], 'notes.txt') }), { code: 'NOT_FOUND' });
  const preview = await service.previewFile({ chatId: chat.id, path: saved.relativePath });
  assert.deepEqual(preview.bytes, Buffer.from(bytes));
  await assert.rejects(service.previewFile({ chatId: 'missing', path: saved.relativePath }), { code: 'NOT_FOUND' });
  await service.archiveChat({ chatId: chat.id });
  assert.deepEqual((await service.previewFile({ chatId: chat.id, path: saved.relativePath })).bytes, Buffer.from(bytes));
  assert.equal(await runtime.controller.getSessionByResource(thread.resourceId), undefined, 'archived previews stay dormant');
  await assert.rejects(client.uploadFile({ chatId: chat.id, file: new File(['content'], 'notes.txt') }), { code: 'CONFLICT' });
});

test('native upload descriptors become saved image bytes and project references through typed Send', { timeout: 30_000 }, async t => {
  const { makeService, runtimes } = await setup('attachment-send');
  const service = makeService(), server = await serve(service);
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  const client = server.client(), chat = await client.createChat({ projectId: 'a' });
  await (await nativeSession(runtimes, chat.id)).thread.rename({ title: 'Native attachment send', pin: true });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const image = await client.uploadImage({ chatId: chat.id, file: new File([Buffer.from(png, 'base64')], 'pixel.png', { type: 'image/png' }) });
  const file = await client.uploadFile({ chatId: chat.id, file: new File(['Attachment notes'], 'notes.md', { type: 'text/markdown' }) });
  const stream = await client.watchChat({ chatId: chat.id }, { signal: abort.signal }); await stream.next();
  await client.send({ chatId: chat.id, text: 'ATTACHMENT_SEND', images: [image], files: [file] });
  const completed = await until(stream, value => !value.display.isRunning && value.messages.some(message => message.role === 'assistant'));
  const user = completed.messages.find(message => message.role === 'signal'); assert.ok(user);
  assert.ok(user.content.parts.some(part => part.type === 'file' && part.data === png && part.mimeType === 'image/png'));
  assert.ok(JSON.stringify(user.content).includes(file.relativePath));
  assert.equal(JSON.stringify(user.content).includes(file.absolutePath), false);
  const request = fixture.requests.findLast(value => lastUserText(value).includes('ATTACHMENT_SEND')); assert.ok(request);
  assert.ok(JSON.stringify(request.messages).includes(`data:image/png;base64,${png}`));
  assert.ok(JSON.stringify(request.messages).includes(file.relativePath));
});
