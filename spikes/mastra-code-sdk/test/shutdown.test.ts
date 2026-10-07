import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Characterizes a gap in pinned native CodeSDK shutdown, not a Kodex workaround.
test('native shutdown closes storage while detached title work is still pending', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-shutdown-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const titleStarted = deferred<void>();
  const releaseTitle = deferred<void>();
  const fixture = await startModelFixture(async request => {
    if (request.model === 'title') {
      titleStarted.resolve();
      await releaseTitle.promise;
      return { text: 'Native delayed title' };
    }
    return { text: 'SAVED_ANSWER' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture', models: ['chat', 'title'] }],
    models: { observerModelOverride: 'fixture/title', reflectorModelOverride: 'fixture/title' },
    observability: { enabled: false },
  }));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
  t.after(async () => {
    releaseTitle.resolve();
    await runtime.dispose();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = await runtime.createSession({ resourceId: 'shutdown-resource', threadId: 'shutdown-thread' });
  const memory = await runtime.codeAgent.getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory);
  const lateFailure = deferred<void>();
  const logger = runtime.codeAgent.__getLogger();
  const errors: string[] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
    if (errors.at(-1)?.includes('Error persisting generated title')) lateFailure.resolve();
  });
  let titleCompleted = false;
  const off = session.subscribe(event => { if (event.type === 'thread_title_updated') titleCompleted = true; });
  try {
    await session.sendMessage({ content: 'Provide the test answer.' });
    await titleStarted.promise;
    const messages = await session.thread.listActiveMessages();
    assert.ok(messages.some(message => message.role === 'assistant' && message.content.parts.some(part => part.type === 'text' && part.text === 'SAVED_ANSWER')));
    assert.equal(session.displayState.get().isRunning, false);
    assert.equal(titleCompleted, false);
    assert.ok('settled' in memory && typeof memory.settled === 'function');
    await memory.settled();
    assert.equal(titleCompleted, false, 'Memory.settled does not join automatic title generation');
    // A larger native drain budget does not wait for standard-run detached titles.
    await runtime.mastra.shutdown({ drainTimeout: 30_000 });
    assert.equal(titleCompleted, false, 'native shutdown returned before the title was released');
    releaseTitle.resolve();
    await lateFailure.promise;
    assert.match(errors.join('\n'), /CLIENT_CLOSED/, 'native title persistence reached the closed native database');
    assert.ok(errors.every(message => message.includes('Error persisting generated title')), 'unrelated agent errors are not expected');
    assert.equal(titleCompleted, false);
    const reopened = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    try {
      const restored = await reopened.createSession({ resourceId: 'shutdown-resource', threadId: 'shutdown-thread' });
      const persisted = await restored.thread.listActiveMessages();
      assert.ok(persisted.some(message => message.role === 'assistant' && message.content.parts.some(part => part.type === 'text' && part.text === 'SAVED_ANSWER')), 'the completed answer survives native shutdown even though background title persistence failed');
    } finally {
      await reopened.dispose();
    }
  } finally {
    releaseTitle.resolve();
    off();
  }
});
