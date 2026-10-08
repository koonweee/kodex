import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createChatService } from '../src/chat-service.js';
import { createChildTools } from '../src/child-tools.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  return { reached: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-child-archive-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `kodex-child-archive-${name}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const sessions: NativeSession[] = [];
  const trace: unknown[] = [];
  const tasks = new Map<string, string>();
  const acknowledged = new Map<string, ReturnType<typeof gate>>();
  const holds: Array<{ release: () => void }> = [];
  const producers = new Map<string, ReturnType<typeof gate>>();
  let runtime!: ProjectRuntime;
  const fixture = await startModelFixture(request => {
    const last = lastUserText(request);
    const marker = ['ACTIVE', 'OTHER', 'LATE'].find(marker => last.includes(`PARENT_${marker}`) || last.includes(`CHILD_${marker}`));
    assert.ok(marker, `Unexpected fixture request: ${last}`);
    if (last.includes(`CHILD_${marker}`)) return { text: `CHILD_RESULT_${marker}` };
    const acknowledgement = request.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'));
    if (acknowledgement) {
      const match = JSON.stringify(acknowledgement.content).match(/Task ID: ([^.\s]+)\./); assert.ok(match);
      tasks.set(marker, match[1]!); acknowledged.get(marker)?.release();
      return { text: `PARENT_CONTINUED_${marker}` };
    }
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: `CHILD_${marker}: bounded archive characterization.` }, id: `delegate-${marker}` }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const service = createChatService({ profile, instanceId: name,
    projects: [{ id: name, name, path: projectPath, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async options => {
      let mounted!: ProjectRuntime;
      mounted = await createProjectRuntime({ ...options,
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        extraTools: createChildTools({ getRuntime: () => mounted }) });
      if (options.projectPath === projectPath) runtime = mounted;
      mounted.controller.onSessionCreated(session => {
        sessions.push(session);
        session.subscribe(event => {
          if (['agent_start', 'agent_end', 'error'].includes(event.type)) trace.push({ session: session.identity.getId(), child: session.getTags().kodexChild === '1', event });
        });
      });
      // Established fixture-only producer join; it does not implement archive
      // semantics or introduce a production dependency on private registration.
      const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
      t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
        const result = register(...args);
        if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
        return result;
      });
      const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
      t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
        unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
      });
      return mounted;
    } });
  t.diagnostic(`Child archive characterization: ${join(root, 'trace.json')}`);
  t.after(async () => {
    // All parents stop before child cancellation publishes terminal signals.
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    for (const hold of holds) hold.release();
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.reached)); }
    const finalTasks = runtime ? (await runtime.mastra.backgroundTaskManager?.listTasks({}))?.tasks : undefined;
    await service.dispose(); await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ trace, tasks: finalTasks, requests: fixture.requests }, null, 2));
    for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  return { service, fixture, tasks, sessions, trace, get runtime() { return runtime; },
    async launch(marker: string) {
      const chat = await service.createChat({ projectId: name });
      const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
      const parent = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(parent);
      const ack = gate(); acknowledged.set(marker, ack);
      await service.send({ chatId: chat.id, text: `PARENT_${marker}: delegate a child and continue.` });
      await ack.reached;
      return { chat, thread, parent, taskId: tasks.get(marker)! };
    },
    hold(marker: string) { const held = fixture.holdNext(`CHILD_${marker}`); holds.push(held); return held; },
    releaseOnCleanup(held: { release: () => void }) { holds.push(held); },
    async child(taskId: string) {
      const rows = await runtime.controller.queryThreads({ metadata: { parentTaskId: taskId } }); assert.equal(rows.length, 1);
      const row = rows[0]!;
      const child = await runtime.controller.getSessionByResource(row.resourceId); assert.ok(child);
      return { row, child };
    } };
}

test('archive cancels its active native child and preserves an unrelated child', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'active');
  const activeHeld = env.hold('ACTIVE'), otherHeld = env.hold('OTHER');
  const active = await env.launch('ACTIVE'); await activeHeld.reached;
  const other = await env.launch('OTHER'); await otherHeld.reached;
  const activeChild = await env.child(active.taskId), otherChild = await env.child(other.taskId);
  const manager = env.runtime.mastra.backgroundTaskManager; assert.ok(manager);
  const otherRunId = otherChild.child.getCurrentRunId(); assert.ok(otherRunId);
  assert.equal((await manager.getTask(active.taskId))?.status, 'running');
  assert.deepEqual(await env.service.archiveChat({ chatId: active.chat.id }), { accepted: true });
  assert.equal(await env.runtime.controller.getSessionByResource(active.thread.resourceId), undefined, 'parent native binding was retired');
  await assert.rejects(env.service.openChat({ chatId: active.chat.id }), { code: 'CONFLICT' });
  const archived = await env.service.listChats(); assert.ok(archived.archivedChatIds.includes(active.chat.id));
  assert.equal((await manager.getTask(active.taskId))?.status, 'cancelled', 'archive cancels its native adopted child task');
  assert.equal(activeChild.child.run.isRunning(), false, 'held child model operation stops before archive accepts');
  assert.equal(await env.runtime.controller.getSessionByResource(activeChild.row.resourceId), undefined);
  assert.equal((await manager.getTask(other.taskId))?.status, 'running');
  assert.equal(otherChild.child.getCurrentRunId(), otherRunId, 'unrelated parent child retains its same actual native run');
  assert.equal(otherChild.child.run.isAbortRequested(), false);
  env.trace.push({ archivedParent: active.chat.id, orphanTask: await manager.getTask(active.taskId), unrelatedTask: await manager.getTask(other.taskId), activeChildRun: activeChild.child.getCurrentRunId(), otherChildRun: otherRunId });
});

test('archive cancels a child admitted before native creation without allowing later model work', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'late');
  env.hold('LATE');
  const launchEntered = gate(), releaseLaunch = gate();
  env.releaseOnCleanup(releaseLaunch);
  // Mount runtime before observing the owned host launch boundary. The real
  // delegate has already captured its invoking parent when createSession runs.
  const unused = await env.service.createChat({ projectId: 'late' });
  assert.ok(unused.id);
  const nativeCreate = env.runtime.createSession.bind(env.runtime);
  t.mock.method(env.runtime, 'createSession', async (input: Parameters<typeof nativeCreate>[0], initialize: Parameters<typeof nativeCreate>[1]) => {
    if (input.tags?.kodexChild === '1') { launchEntered.release(); await releaseLaunch.reached; }
    return nativeCreate(input, initialize);
  });
  const active = await env.launch('LATE'); await launchEntered.reached;
  const manager = env.runtime.mastra.backgroundTaskManager; assert.ok(manager);
  assert.equal(env.sessions.filter(session => session.getTags().kodexChild === '1').length, 0);
  await env.service.archiveChat({ chatId: active.chat.id });
  assert.equal(await env.runtime.controller.getSessionByResource(active.thread.resourceId), undefined);
  assert.equal((await manager.getTask(active.taskId))?.status, 'cancelled', 'archive cancels already admitted native tasks');
  const deleted = gate();
  const off = env.runtime.controller.onSessionDeleted(session => { if (session.getTags().parentTaskId === active.taskId) deleted.release(); });
  t.after(off);
  releaseLaunch.release();
  await deleted.reached;
  const rows = await env.runtime.controller.queryThreads({ metadata: { parentTaskId: active.taskId } });
  assert.equal(rows.length, 1, 'an already admitted creation may retain an empty native child row');
  assert.equal(await env.runtime.controller.getSessionByResource(rows[0]!.resourceId), undefined);
  assert.equal((await manager.getTask(active.taskId))?.status, 'cancelled');
  const messages = await env.runtime.controller.queryThreadMessages({ threadId: rows[0]!.id, resourceId: rows[0]!.resourceId });
  assert.equal(messages.messages.length, 0, 'late setup cannot submit child input after cancellation');
  assert.equal(env.fixture.requests.filter(request => lastUserText(request).includes('CHILD_LATE')).length, 0);
});

test('archive joins an admitted child release whose native binding is already cleared before acknowledging retirement', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'release-overlap');
  const activeHeld = env.hold('ACTIVE'), otherHeld = env.hold('OTHER');
  const active = await env.launch('ACTIVE'); await activeHeld.reached;
  const other = await env.launch('OTHER'); await otherHeld.reached;
  const activeChild = await env.child(active.taskId), otherChild = await env.child(other.taskId);
  const manager = env.runtime.mastra.backgroundTaskManager; assert.ok(manager);
  const otherRunId = otherChild.child.getCurrentRunId(); assert.ok(otherRunId);
  activeHeld.release();
  const completed = await manager.waitForNextTask([active.taskId], { timeoutMs: 5_000 });
  assert.equal(completed.status, 'completed');
  assert.equal(await env.runtime.controller.getSessionByResource(activeChild.row.resourceId), activeChild.child);
  const cleared = gate(), releaseLock = gate(), joiningRelease = gate();
  env.releaseOnCleanup(releaseLock);
  const clear = activeChild.child.thread.clearAndReleaseLock.bind(activeChild.child.thread);
  t.mock.method(activeChild.child.thread, 'clearAndReleaseLock', async () => {
    await clear(); cleared.release(); await releaseLock.reached;
  });
  const release = env.runtime.releaseSession.bind(env.runtime);
  let childReleases = 0;
  t.mock.method(env.runtime, 'releaseSession', (input: Parameters<typeof release>[0]) => {
    const result = release(input);
    if (input.resourceId === activeChild.row.resourceId && ++childReleases === 2) joiningRelease.release();
    return result;
  });
  const retiring = env.runtime.releaseSession({ resourceId: activeChild.row.resourceId });
  void retiring.catch(() => {});
  await cleared.reached;
  let archiveSettled = false;
  const archive = env.service.archiveChat({ chatId: active.chat.id });
  void archive.then(() => { archiveSettled = true; }, () => { archiveSettled = true; });
  t.after(async () => { releaseLock.release(); await archive.catch(() => {}); });
  await cleared.reached; await joiningRelease.reached;
  assert.equal(activeChild.child.thread.getId(), null, 'native admitted release has already cleared its child binding');
  assert.equal(archiveSettled, false, 'archive waits for the admitted native release after the binding clears');
  assert.equal((await manager.getTask(active.taskId))?.status, 'completed');
  assert.equal((await manager.getTask(other.taskId))?.status, 'running');
  assert.equal(otherChild.child.getCurrentRunId(), otherRunId);
  releaseLock.release(); await retiring;
  assert.deepEqual(await archive, { accepted: true });
  assert.equal(childReleases, 2, 'explicit retirement and archive join one owned release');
  assert.equal(await env.runtime.controller.getSessionByResource(activeChild.row.resourceId), undefined);
  const saved = await env.runtime.controller.queryThreadById({ threadId: activeChild.row.id });
  assert.equal(saved?.id, activeChild.row.id, 'joined live-binding deletion preserves the native child thread');
  assert.equal(saved?.metadata?.parentTaskId, active.taskId);
  assert.equal((await manager.getTask(other.taskId))?.status, 'running');
  assert.equal(otherChild.child.getCurrentRunId(), otherRunId, 'unrelated model run remains unchanged across the joined release');
});
