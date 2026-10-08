import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createChatService, type ChatSnapshot } from '../src/chat-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

async function until(iterator: AsyncIterator<ChatSnapshot>, predicate: (value: ChatSnapshot) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (predicate(next.value)) return next.value; }
}
function correlation(message: ChatSnapshot['messages'][number]) {
  const signal = message.content.metadata?.signal as { metadata?: { clientId?: string } } | undefined;
  return signal?.metadata?.clientId;
}

test('native question replies persist correlation and converge across RPC peers and restart', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-question-replies-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local', models: ['chat'] }] }));
  let runtime!: ProjectRuntime;
  let service: ReturnType<typeof createChatService> | undefined;
  let server: Awaited<ReturnType<typeof serveRouter>> | undefined;
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server?.close(); await service?.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  async function mount() {
    service = createChatService({ profile, instanceId: 'questions', directoryHome: projectPath,
      projects: [{ id: 'questions', name: 'Questions', path: projectPath, runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async input => {
        const mounted = await createProjectRuntime({ ...input, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
        if (input.runtimeRoot === join(root, 'runtime')) runtime = mounted;
        return mounted;
      } });
    server = await serveRouter(createChatRouter(service), 0);
  }
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server!.url}/rpc` }));
  await mount(); let first = client(), second = client();
  const chat = await first.createChat({ projectId: 'questions' });
  await first.renameChat({ chatId: chat.id, title: 'Native question answers' });
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  const observer = await second.watchChat({ chatId: chat.id }, { signal: abort.signal }); await observer.next();
  const clientId = 'kodex-question-reply:v1:["[null,\\"native-question\\",0]","attempt-1"]';
  const text = 'Use <notes> & keep "quotes"';
  const before = await runtime.controller.queryThreads({});
  await assert.rejects(first.replyToQuestion({ chatId: 'missing', text, clientId }), { code: 'NOT_FOUND' });
  assert.equal((await runtime.controller.queryThreads({})).length, before.length);
  assert.deepEqual(await first.replyToQuestion({ chatId: chat.id, text, clientId }), { accepted: true });
  const saved = await until(observer, value => !value.display.isRunning && value.messages.some(message => correlation(message) === clientId));
  const answer = saved.messages.find(message => correlation(message) === clientId)!;
  assert.notEqual(answer.id, clientId, 'correlation does not replace the native message identity');
  assert.equal(answer.role, 'signal');
  assert.deepEqual(answer.content.parts.map(part => part.type === 'text' ? part.text : part.type), [text]);
  const peer = await first.openChat({ chatId: chat.id });
  assert.equal(peer.messages.find(message => correlation(message) === clientId)?.id, answer.id);
  await observer.return();
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
  await server!.close(); server = undefined; await service!.dispose(); service = undefined;
  await mount(); first = client(); second = client();
  const reopened = await second.openChat({ chatId: chat.id });
  assert.equal(reopened.messages.find(message => correlation(message) === clientId)?.id, answer.id);
  assert.equal(fixture.requests.length, 1, 'reopening saved question answers does not send more model input');
  await first.archiveChat({ chatId: chat.id });
  await assert.rejects(second.replyToQuestion({ chatId: chat.id, text: 'late reply', clientId: 'late-attempt' }), { code: 'CONFLICT' });
  assert.equal(fixture.requests.length, 1);
});
