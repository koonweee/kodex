import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { createSessionProjection, serveProjection, type ProjectionRouter } from '../src/transport.js';
import { startModelFixture } from './fixtures/model-server.js';

test('two oRPC/SSE clients converge from native state after disconnect during a live run', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-transport-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture', models: ['chat'] }], observability: { enabled: false } }));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
  const session = await runtime.createSession({ resourceId: 'transport-chat', threadId: 'transport-thread' });
  const projection = createSessionProjection(session);
  const server = await serveProjection(projection);
  const client = (): RouterClient<ProjectionRouter> => createORPCClient(new RPCLink({ url: server.url }));
  const first = client();
  const second = client();
  const abortA = new AbortController();
  const abortB = new AbortController();
  try {
    // A cancelled read must not return stale content once the native read resolves.
    const originalRead = session.thread.listActiveMessages.bind(session.thread);
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const readEntered = new Promise<void>(resolve => { enteredRead = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const mocked = t.mock.method(session.thread, 'listActiveMessages', async () => {
      enteredRead(); await readGate; return originalRead();
    });
    const cancelled = new AbortController();
    const pending = projection.snapshot(cancelled.signal);
    await readEntered;
    cancelled.abort(); releaseRead();
    await assert.rejects(pending, { name: 'AbortError' });
    mocked.mock.restore();
    const a = await first.watch(undefined, { signal: abortA.signal });
    const b = await second.watch(undefined, { signal: abortB.signal });
    const initialA = await a.next();
    const initialB = await b.next();
    assert.equal(initialA.done, false);
    assert.equal(initialB.done, false);
    assert.equal(initialA.value?.epoch, initialB.value?.epoch);
    assert.equal(initialA.value?.display.isRunning, false);
    const hold = fixture.holdNext('CLIENT_DISCONNECT');
    const running = session.sendMessage({ content: 'CLIENT_DISCONNECT' });
    await hold.reached;
    abortA.abort();
    await a.return?.().catch(() => undefined);
    assert.equal(session.displayState.get().isRunning, true, 'disconnect must not abort native execution');
    let latest = initialB.value;
    while (!latest.display.isRunning || !latest.display.currentMessage) {
      const next = await b.next();
      assert.equal(next.done, false);
      latest = next.value;
    }
    assert.equal(latest.display.isRunning, true, 'peer receives live state before model completion');
    hold.release();
    await running;
    for (;;) {
      const update = await b.next();
      assert.equal(update.done, false);
      assert.ok(update.value.revision > (latest?.revision ?? -1));
      latest = update.value;
      if (!latest.display.isRunning && JSON.stringify(latest.messages).includes('started:CLIENT_DISCONNECT')) break;
    }
    const reconnectAbort = new AbortController();
    const reconnect = await first.watch(undefined, { signal: reconnectAbort.signal });
    const next = await reconnect.next();
    assert.equal(next.done, false);
    const snapshot = next.value;
    assert.equal(snapshot?.epoch, latest.epoch);
    assert.ok(snapshot!.revision >= latest.revision);
    assert.deepEqual(snapshot?.messages, latest.messages);
    assert.equal(snapshot?.display.isRunning, false);
    reconnectAbort.abort();
    await reconnect.return?.().catch(() => undefined);
    // A slow subscriber retains only an invalidation, then re-reads full native state.
    const slow = projection.watch();
    await slow.next();
    await session.sendMessage({ content: 'AFTER_RECONNECT' });
    const caughtUp = (await slow.next()).value;
    assert.match(JSON.stringify(caughtUp?.messages), /fixture:AFTER_RECONNECT/);
    await slow.return(undefined);
  } finally {
    abortA.abort(); abortB.abort();
    await server.close();
    projection.dispose();
    await runtime.dispose();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
