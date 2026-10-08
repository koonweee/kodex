import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { noopObserve } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { createControlAutomationTools } from '../src/control-automation-tools.js';
import { AUTOMATION_WORKFLOW_ID } from '../src/automation-workflow.js';
import { createControlTools } from '../src/control-tools.js';
import { createChatService, type ChatService } from '../src/chat-service.js';
import { createChatRouter } from '../src/chat-router.js';
import { createAutomationRouter } from '../src/automation-router.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime, type NativeSession } from '../src/runtime.js';
import { openProductRegistry } from '../src/product-registry.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture, type FixtureRequest, type FixtureReply } from './fixtures/model-server.js';

let profileRoot: string, profile: SpikeProfile;
before(async () => {
  profileRoot = await realpath(await mkdtemp(join(tmpdir(), 'kodex-control-automation-profile-')));
  profile = activateProfile(resolveProfile(join(profileRoot, 'profile')));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function setup(t: TestContext, reply?: (request: FixtureRequest) => FixtureReply | Promise<FixtureReply>) {
  const root = await mkdtemp(join(profileRoot, 'case-'));
  const fixture = await startModelFixture(reply);
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null }, preferences: { yolo: true },
    lsp: false, observability: { enabled: false },
  }));
  const producers = new Map<string, ReturnType<typeof gate>>(), sessions = new Set<NativeSession>();
  const runtimes: ProjectRuntime[] = [];
  let service!: ChatService;
  function open() {
    service = createChatService({ profile, instanceId: 'control-automation-proof', directoryHome: root,
      registryFactory: () => openProductRegistry(resolveProfile(join(root, 'product')), { standaloneCwd: root }),
      runtimeFactory: async options => {
        let runtime!: ProjectRuntime;
        runtime = await createProjectRuntime({ ...options, subagents: [],
          extraTools: { ...createControlTools({ getRuntime: () => runtime, getService: () => service }),
            ...createControlAutomationTools({ getRuntime: () => runtime, getService: () => service }) },
          modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        });
        runtimes.push(runtime);
        runtime.controller.onSessionCreated(session => { sessions.add(session); });
        const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
        const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
        // Test-only passthrough joins producers before storage teardown.
        t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
          const result = register(...args);
          if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
          return result;
        });
        t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
          unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
        });
        return runtime;
      },
    });
  }
  open();
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(row => row.promise)); }
  }
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true });
  });
  return { fixture, settled, get service() { return service; }, get runtime() { return runtimes.at(-1)!; },
    async restart() { await settled(); await service.dispose(); open(); await service.initializeAutomations(); },
  };
}
const input = (targetThreadId: string) => ({ name: 'Control calendar', prompt: 'CONTROL_MANUAL_WAKE', targetThreadId, cron: '0 0 1 1 *', timezone: 'UTC' });
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;

test('Control creation can atomically persist a paused native schedule and browser creation stays active', { timeout: 20_000 }, async t => {
  const env = await setup(t), chat = await env.service.createChat({});
  const store = await env.runtime.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const nativeCreate = t.mock.method(store, 'createSchedule');
  const automation = await env.service.automations.create(input(chat.id), { status: 'paused' });
  assert.equal(automation.status, 'paused');
  assert.equal((await env.runtime.mastra.schedules.get(automation.id))?.status, 'paused');
  const active = await env.service.automations.create(input(chat.id));
  assert.equal(active.status, 'active');
  assert.deepEqual(nativeCreate.mock.calls.map(call => call.arguments[0].status), ['paused', 'active'], 'the first native writes already have their intended status');
  assert.equal(env.fixture.requests.length, 0);
  await env.restart();
  assert.equal((await env.service.automations.list()).find(row => row.id === automation.id)?.status, 'paused');
  assert.equal(env.fixture.requests.length, 0);
});


test('native validation is read-only, rejects invalid or archived targets and never saves a temporary schedule', { timeout: 20_000 }, async t => {
  const env = await setup(t), chat = await env.service.createChat({});
  const thread = await env.runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  await env.restart();
  const store = await env.runtime.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const before = await store.listSchedules({});
  const created = t.mock.method(store, 'createSchedule'), deleted = t.mock.method(store, 'deleteSchedule');
  const validation = await env.service.automations.validate(input(chat.id));
  assert.equal(validation.valid, true); assert.ok(Number.isFinite(validation.nextFireAt) && validation.nextFireAt > Date.now());
  for (const patch of [{ cron: 'invalid /private/calendar' }, { timezone: 'Not/A_Timezone' },
    { cron: '0 0 0 1 1 * 2000' }, { name: '' }, { prompt: '' }]) {
    await assert.rejects(env.service.automations.validate({ ...input(chat.id), ...patch }), code('BAD_REQUEST'));
  }
  await assert.rejects(env.service.automations.validate(input('foreign-chat')), code('NOT_FOUND'));
  assert.deepEqual(await store.listSchedules({}), before);
  assert.equal(created.mock.callCount(), 0); assert.equal(deleted.mock.callCount(), 0);
  assert.equal(await env.runtime.controller.getSessionByResource(thread.resourceId), undefined);
  assert.equal(env.fixture.requests.length, 0);
  const schedule = await env.service.automations.create(input(chat.id), { status: 'paused' });
  const foreign = await env.runtime.mastra.schedules.create({ workflowId: AUTOMATION_WORKFLOW_ID,
    inputData: { name: 'Other owner', prompt: 'MUST_NOT_RUN', targetThreadId: chat.id }, resourceId: thread.resourceId,
    cron: input(chat.id).cron, timezone: 'UTC', status: 'paused' });
  await assert.rejects(env.service.automations.get({ id: foreign.id }), code('NOT_FOUND'));
  await assert.rejects(env.service.automations.run({ id: foreign.id }), code('NOT_FOUND'));
  assert.deepEqual(await store.listTriggers(foreign.id, { limit: 100 }), []);
  // A public native row with a mismatched resource cannot bypass target ownership.
  await env.runtime.mastra.schedules.update(schedule.id, { resourceId: 'foreign-resource' });
  await assert.rejects(env.service.automations.run({ id: schedule.id }), code('NOT_FOUND'));
  await env.runtime.mastra.schedules.update(schedule.id, { resourceId: thread.resourceId });
  await env.service.archiveChat({ chatId: chat.id });
  await assert.rejects(env.service.automations.validate(input(chat.id)), code('CONFLICT'));
  await assert.rejects(env.service.automations.run({ id: schedule.id }), code('CONFLICT'));
  assert.equal(env.fixture.requests.length, 0);
  assert.deepEqual(await env.service.automations.runs({ id: schedule.id }), []);
});

function output(request: FixtureRequest, index: number): Record<string, unknown> {
  const text = request.messages.filter(message => message.role === 'tool')[index]?.content;
  assert.equal(typeof text, 'string');
  return JSON.parse(text as string) as Record<string, unknown>;
}
async function until<T>(iterator: AsyncIterator<T>, predicate: (row: T) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (predicate(next.value)) return next.value; }
}

test('all nine native automation Control tools share two-client state and manual dispatch acknowledges before held model completion', { timeout: 30_000 }, async t => {
  let targetId = '', automationId = '';
  let calendarBeforeRun: { nextFireAt: number; status: string } | undefined;
  const admitted = gate(), continueControl = gate(); t.after(continueControl.release);
  const env = await setup(t, async request => {
    if (lastUserText(request).includes('CONTROL_MANUAL_WAKE')) return { text: 'CONTROL_TARGET_FINISHED' };
    const received = request.messages.filter(message => message.role === 'tool').length;
    if (received >= 2) automationId = output(request, 1).id as string;
    if (received === 7) {
      const native = await env.runtime.mastra.schedules.get(automationId); assert.ok(native);
      calendarBeforeRun = { nextFireAt: native.nextFireAt, status: native.status };
    }
    if (received === 8) { admitted.release(); await continueControl.promise; }
    const calls = [
      { name: 'validate_automation', arguments: input(targetId) },
      { name: 'create_automation', arguments: input(targetId) },
      { name: 'list_automations', arguments: { threadId: targetId } },
      { name: 'get_automation', arguments: { automationId } },
      { name: 'update_automation', arguments: { automationId, name: 'Edited by Control' } },
      { name: 'resume_automation', arguments: { automationId } },
      { name: 'pause_automation', arguments: { automationId } },
      { name: 'run_automation_now', arguments: { automationId } },
      { name: 'delete_automation', arguments: { automationId } },
    ];
    return received < calls.length ? { toolCalls: [{ ...calls[received]!, id: `control-automation-${received}` }] } : { text: 'CONTROL_AUTOMATIONS_FINISHED' };
  });
  const control = await env.service.createChat({}), target = await env.service.createChat({}); targetId = target.id;
  const targetThread = await env.runtime.controller.queryThreadById({ threadId: target.id }); assert.ok(targetThread);
  await env.restart();
  const router = { ...createChatRouter(env.service), ...createAutomationRouter(env.service.automations) };
  const server = await serveRouter(router, 0); t.after(() => server.close());
  const client = (): RouterClient<typeof router> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const a = client(), b = client();
  await a.openChat({ chatId: control.id });
  assert.equal(await env.runtime.controller.getSessionByResource(targetThread.resourceId), undefined);
  const abort = new AbortController(); t.after(() => abort.abort());
  const watches = await Promise.all([a.watchAutomations(undefined, { signal: abort.signal }), b.watchAutomations(undefined, { signal: abort.signal })]);
  const iterators = watches.map(watch => watch[Symbol.asyncIterator]());
  for (const next of await Promise.all(iterators.map(iterator => iterator.next()))) assert.deepEqual(next.value?.rows, []);
  const hold = env.fixture.holdNext('CONTROL_MANUAL_WAKE'); t.after(hold.release);
  const controlThread = await env.runtime.controller.queryThreadById({ threadId: control.id }); assert.ok(controlThread);
  const controlSession = await env.runtime.controller.getSessionByResource(controlThread.resourceId); assert.ok(controlSession);
  const ended = gate(); const off = controlSession.subscribe(event => { if (event.type === 'agent_end') ended.release(); }); t.after(off);
  await a.send({ chatId: control.id, text: 'CONTROL_AUTOMATIONS' });
  await admitted.promise; await hold.reached;
  assert.ok(automationId);
  for (const iterator of iterators) {
    const observed = await until(iterator, event => event.rows.some(row => row.id === automationId && row.name === 'Edited by Control' && row.status === 'paused'));
    assert.equal(observed.rows.find(row => row.id === automationId)?.targetThreadId, target.id);
  }
  const pending = await b.listAutomations(); assert.equal(pending[0]?.status, 'paused');
  assert.ok(calendarBeforeRun); assert.equal(calendarBeforeRun.status, 'paused');
  const resumedRequest = env.fixture.requests.findLast(request => lastUserText(request) === 'CONTROL_AUTOMATIONS'); assert.ok(resumedRequest);
  assert.equal(output(resumedRequest, 0).valid, true);
  assert.equal(output(resumedRequest, 1).status, 'paused');
  assert.equal(output(resumedRequest, 3).id, automationId);
  const admission = output(resumedRequest, 7);
  assert.equal(admission.scheduleId, automationId); assert.equal(typeof admission.claimId, 'string');
  const runs = await b.listAutomationRuns({ id: automationId });
  assert.equal(runs.length, 1); assert.equal(runs[0]?.triggerKind, 'manual'); assert.equal(runs[0]?.outcome, 'published');
  const targetSnapshot = await b.openChat({ chatId: target.id }); assert.equal(targetSnapshot.display.isRunning, true);
  assert.equal((await env.runtime.mastra.schedules.get(automationId))?.nextFireAt, calendarBeforeRun.nextFireAt);
  continueControl.release(); await ended.promise;
  for (const iterator of iterators) await until(iterator, event => event.rows.length === 0);
  const final = await a.openChat({ chatId: control.id });
  const invocations = final.messages.flatMap(message => message.content.parts).filter(part => part.type === 'tool-invocation');
  assert.equal(invocations.length, 9);
  for (const part of invocations) {
    assert.equal(part.toolInvocation.state, 'result'); assert.notEqual(part.toolInvocation.isError, true);
  }
  assert.equal(await env.runtime.mastra.schedules.get(automationId), null);
  const targetEnded = gate();
  const targetSession = await env.runtime.controller.getSessionByResource(targetThread.resourceId); assert.ok(targetSession);
  const targetOff = targetSession.subscribe(event => { if (event.type === 'agent_end') targetEnded.release(); }); t.after(targetOff);
  hold.release(); await targetEnded.promise; await env.settled();
  abort.abort();
  await env.restart();
  assert.deepEqual(await env.service.automations.list(), []);
  assert.equal(await env.runtime.controller.getSessionByResource(targetThread.resourceId), undefined);
  const saved = await env.service.readControlHistory({ chatId: control.id });
  assert.equal(saved.messages.flatMap(message => message.content.parts).filter(part => part.type === 'tool-invocation').length, 9);
});


test('automation Control rejects missing, stale, fork and fresh child native origins before schedule writes', { timeout: 20_000 }, async t => {
  const env = await setup(t), chat = await env.service.createChat({});
  const thread = await env.runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await env.runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  const tools = createControlAutomationTools({ getRuntime: () => env.runtime, getService: () => env.service });
  const create = tools.create_automation; assert.ok(create.execute);
  await assert.rejects(create.execute(input(chat.id), { requestContext: new RequestContext(), observe: noopObserve }), /original live ordinary chat/);
  const context = await session.machinery.buildRequestContext();
  const origin = context.get('controller') as AgentControllerRequestContext<MastraCodeState>;
  const forged = new RequestContext(); forged.set('controller', { ...origin, session: { ...origin.session, id: 'wrong-session' } });
  await assert.rejects(create.execute(input(chat.id), { requestContext: forged, observe: noopObserve }), /original live ordinary chat/);
  const child = await env.runtime.createSession({ resourceId: 'control-child', threadId: 'control-child', tags: { kodexChild: '1' } });
  await child.thread.rename({ title: 'Control child' });
  await assert.rejects(create.execute(input(chat.id), { requestContext: await child.machinery.buildRequestContext(), observe: noopObserve }), /original live ordinary chat/);
  const fork = await env.runtime.createSession({ resourceId: 'control-fork', threadId: 'control-fork' });
  await fork.thread.rename({ title: 'Control fork' }); await fork.thread.setSetting({ key: 'forkedSubagent', value: true });
  await assert.rejects(create.execute(input(chat.id), { requestContext: await fork.machinery.buildRequestContext(), observe: noopObserve }), /original live ordinary chat/);
  const explicitlyActive = await create.execute({ ...input(chat.id), enabled: true }, { requestContext: context, observe: noopObserve }) as { id: string; status: string };
  assert.equal(explicitlyActive.status, 'active');
  assert.equal((await env.runtime.mastra.schedules.get(explicitlyActive.id))?.status, 'active');
  await env.service.automations.remove({ id: explicitlyActive.id });
  await env.runtime.releaseSession({ resourceId: thread.resourceId });
  await assert.rejects(create.execute(input(chat.id), { requestContext: context, observe: noopObserve }), /original live ordinary chat/);
  assert.deepEqual(await env.service.automations.list(), []);
  assert.equal(env.fixture.requests.length, 0);
});
