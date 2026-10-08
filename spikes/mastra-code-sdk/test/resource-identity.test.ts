import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

type OverrideSource = 'global' | 'project' | 'environment';
const sources: OverrideSource[] = ['global', 'project', 'environment'];
const sharedResource = (source: OverrideSource) => `shared-${source}-default`;

async function writeOverride(directory: string, resourceId: string) {
  const configPath = join(directory, '.kodex-mastra-spike');
  await mkdir(configPath, { recursive: true });
  await writeFile(join(configPath, 'database.json'), JSON.stringify({ resourceId }));
}

async function inspectResourceIdentity(root: string, source: OverrideSource) {
  // HOME is synthetic only in this subprocess; production profile activation
  // never changes HOME. Native defaults still discover the namespaced files.
  assert.equal(homedir(), join(root, 'outside-home'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture(request => ({ text: `fixture:${lastUserText(request)}` }));
  const runtimes: ProjectRuntime[] = [];
  try {
    await writeFile(profile.settingsPath, JSON.stringify({
      models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/chat' },
      customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
      observability: { enabled: false },
      lsp: false,
    }));
    await writeOverride(homedir(), source === 'global' ? sharedResource(source) : 'lower-priority-global');
    const projects = await Promise.all(['a', 'b'].map(async name => {
      const projectPath = join(root, `project-${name}`);
      await mkdir(projectPath, { recursive: true });
      if (source !== 'global') await writeOverride(projectPath, source === 'project' ? sharedResource(source) : 'lower-priority-project');
      return { projectPath, runtimeRoot: join(root, `runtime-${name}`), profile,
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
    }));
    const mount = async (projectIndex: number) => {
      const runtime = await createProjectRuntime(projects[projectIndex]!);
      runtimes.push(runtime);
      // Exercise the actual mounted controller default, rather than merely
      // calling the discovery helper: this proves the override was applied.
      const defaultSession = await runtime.controller.createSession({ threadId: `default-${projectIndex}` });
      assert.equal(defaultSession.identity.getResourceId(), sharedResource(source));
      assert.equal(defaultSession.identity.getDefaultResourceId(), sharedResource(source));
      await runtime.controller.deleteSession({ resourceId: defaultSession.identity.getResourceId() });
      return runtime;
    };
    const [a, b] = await Promise.all([mount(0), mount(1)]);
    assert.equal(a.sessionId, b.sessionId, 'a shared override also collides mounted project default session metadata');
    const chats = [
      { projectIndex: 0, resourceId: 'explicit-a-left-resource', threadId: 'explicit-a-left-thread', marker: 'ONLY_A_LEFT' },
      { projectIndex: 0, resourceId: 'explicit-a-right-resource', threadId: 'explicit-a-right-thread', marker: 'ONLY_A_RIGHT' },
      { projectIndex: 1, resourceId: 'explicit-b-resource', threadId: 'explicit-b-thread', marker: 'ONLY_B' },
    ];
    const assertIdentityAndHistory = async (runtime: ProjectRuntime, session: NativeSession, chat: typeof chats[number]) => {
      assert.equal(session.identity.getResourceId(), chat.resourceId);
      assert.equal(session.identity.getDefaultResourceId(), chat.resourceId);
      assert.equal(session.thread.getId(), chat.threadId);
      assert.equal(session.state.get().omScope, 'thread');
      const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
      assert.ok(memory, 'the real native agent owns memory');
      const thread = await memory.getThreadById({ threadId: chat.threadId });
      assert.equal(thread?.resourceId, chat.resourceId, 'persisted native memory uses the explicit resource');
      const ownedThreads = await runtime.controller.queryThreads({ resourceId: chat.resourceId });
      assert.deepEqual(ownedThreads.map(thread => thread.id), [chat.threadId], 'resource-scoped native history lists only this chat');
      const messages = JSON.stringify(await session.thread.listActiveMessages());
      assert.ok(messages.includes(chat.marker), 'native chat history contains its own completed turn');
      for (const other of chats) if (other !== chat) assert.ok(!messages.includes(other.marker), `history leaked ${other.marker} into ${chat.threadId}`);
    };
    const initial = await Promise.all(chats.map(async chat => {
      const runtime = chat.projectIndex === 0 ? a : b;
      const session = await runtime.createSession({ resourceId: chat.resourceId, threadId: chat.threadId });
      await session.thread.rename({ title: chat.threadId });
      await session.sendMessage({ content: chat.marker });
      await assertIdentityAndHistory(runtime, session, chat);
      return session;
    }));
    assert.notEqual(initial[0], initial[1], 'two chats in one project remain distinct native sessions');
    await Promise.all([a.dispose(), b.dispose()]);
    const reopened = await Promise.all([mount(0), mount(1)]);
    await Promise.all(chats.map(async chat => {
      const runtime = reopened[chat.projectIndex]!;
      const session = await runtime.createSession({ resourceId: chat.resourceId, threadId: chat.threadId });
      await assertIdentityAndHistory(runtime, session, chat);
      const followup = `FOLLOWUP_${chat.marker}`;
      await session.sendMessage({ content: followup });
      // Verify native memory actually feeds the resumed model, not just a
      // separate history listing that happens to return the correct rows.
      const requests = fixture.requests.filter(request => lastUserText(request) === followup);
      assert.ok(requests.length > 0, 'the follow-up reached the local model fixture');
      for (const request of requests) {
        const precedingMessages = JSON.stringify(request.messages.slice(0, -1));
        assert.ok(precedingMessages.includes(chat.marker), 'reopened native memory supplies the original turn');
        for (const other of chats) if (other !== chat) assert.ok(!precedingMessages.includes(other.marker), `model memory leaked ${other.marker} into ${chat.threadId}`);
      }
      await assertIdentityAndHistory(runtime, session, chat);
    }));
  } finally {
    for (const runtime of runtimes.reverse()) await runtime.dispose();
    await fixture.close();
  }
}

if (process.env.KODEX_RESOURCE_IDENTITY_FIXTURE === '1') {
  const source = process.argv[3] as OverrideSource;
  assert.ok(sources.includes(source));
  await inspectResourceIdentity(process.argv[2]!, source);
} else {
  for (const source of sources) {
    test(`${source} resource overrides leave explicit chats and reopened native memory separate`, { timeout: 60_000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), `kodex-mastra-resource-${source}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, 'outside-home'));
      await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), root, source], {
        env: { ...process.env, HOME: join(root, 'outside-home'), MASTRA_RESOURCE_ID: source === 'environment' ? sharedResource(source) : '', KODEX_RESOURCE_IDENTITY_FIXTURE: '1' },
        timeout: 50_000,
        maxBuffer: 1024 * 1024,
      });
    });
  }
}
