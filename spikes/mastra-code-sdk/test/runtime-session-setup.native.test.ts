import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test, type TestContext } from 'node:test';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';

function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-session-setup-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, models: { observerModelOverride: null, reflectorModelOverride: null } }));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kodex-session-setup-'));
  const runtime = await createProjectRuntime({ profile, projectPath: root, runtimeRoot: join(root, 'runtime'), subagents: [] });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  return runtime;
}

test('host session creation awaits native configuration before exposing the binding', { timeout: 20_000 }, async t => {
  const runtime = await setup(t);
  const target = { resourceId: 'configured-resource', threadId: 'configured-thread' };
  const session = await runtime.createSession(target, async (session, assertActive) => {
    assertActive();
    await session.thread.rename({ title: 'Configured before exposure', pin: true });
  });
  assert.equal((await runtime.controller.queryThreadById({ threadId: target.threadId }))?.title, 'Configured before exposure');
  assert.equal(session.thread.getId(), target.threadId);
});


test('concurrent callers wait for one setup while independent scopes remain usable', { timeout: 20_000 }, async t => {
  const runtime = await setup(t), entered = gate(), resume = gate();
  t.after(resume.resolve);
  const target = { resourceId: 'shared', threadId: 'shared-thread' };
  let owner: NativeSession | undefined, escaped = false;
  const first = runtime.createSession(target, async session => {
    owner = session; entered.resolve(); await resume.promise;
    await session.thread.rename({ title: 'Ready', pin: true });
  });
  await entered.promise;
  const second = runtime.createSession(target).then(session => { escaped = true; return session; });
  const peer = await runtime.createSession({ ...target, scope: 'independent', threadId: 'peer-thread' });
  assert.equal(escaped, false); assert.notEqual(peer, owner);
  assert.equal(runtime.sessionsForThread(target)[0]?.session, owner, 'retirement can see setup before exposure');
  resume.resolve();
  assert.equal(await first, owner); assert.equal(await second, owner);
  assert.equal((await runtime.controller.queryThreadById({ threadId: target.threadId }))?.title, 'Ready');
});

test('failed initialization rejects every waiter after cleanup and allows explicit retry', { timeout: 20_000 }, async t => {
  const runtime = await setup(t), entered = gate(), resume = gate(); t.after(resume.resolve);
  const target = { resourceId: 'failed-setup', threadId: 'failed-thread' };
  const first = runtime.createSession(target, async () => { entered.resolve(); await resume.promise; throw new Error('SETUP_FAILED'); });
  const failedFirst = assert.rejects(first, /SETUP_FAILED/);
  await entered.promise;
  const failedSecond = assert.rejects(runtime.createSession(target), /SETUP_FAILED/);
  resume.resolve(); await Promise.all([failedFirst, failedSecond]);
  assert.equal(await runtime.controller.getSessionByResource(target.resourceId), undefined);
  assert.ok(await runtime.controller.queryThreadById({ threadId: target.threadId }), 'native history ownership survives failed live setup');
  const retried = await runtime.createSession(target, async session => { await session.thread.rename({ title: 'Retried', pin: true }); });
  assert.equal(retried.thread.getId(), target.threadId);
});

for (const action of ['release', 'dispose', 'abort'] as const) test(`${action} during initialization prevents later input admission`, { timeout: 20_000 }, async t => {
  const runtime = await setup(t), entered = gate(), resume = gate(); t.after(resume.resolve);
  const target = { resourceId: `retire-${action}`, threadId: `retire-${action}` };
  let owner!: NativeSession, admitted = false;
  const first = runtime.createSession(target, async (session, assertActive) => {
    owner = session; entered.resolve(); await resume.promise; assertActive(); admitted = true;
  });
  const rejected = assert.rejects(first, /setup was interrupted/);
  await entered.promise;
  let retiring: Promise<void> | undefined;
  if (action === 'dispose') retiring = runtime.dispose();
  else if (action === 'release') await runtime.releaseSession({ resourceId: target.resourceId });
  else owner.abort();
  resume.resolve(); await rejected; await retiring;
  assert.equal(admitted, false);
  assert.equal(await runtime.controller.getSessionByResource(target.resourceId), undefined);
});


test('a concurrent different-thread request waits for setup then selects its requested native thread', { timeout: 20_000 }, async t => {
  const runtime = await setup(t), entered = gate(), resume = gate();
  t.after(resume.resolve);
  let escaped = false;
  const first = runtime.createSession({ resourceId: 'switch-resource', threadId: 'first-thread' }, async session => {
    entered.resolve(); await resume.promise;
    await session.thread.rename({ title: 'First configured', pin: true });
  });
  await entered.promise;
  const second = runtime.createSession({ resourceId: 'switch-resource', threadId: 'second-thread' }).then(session => {
    escaped = true; return session;
  });
  await runtime.createSession({ resourceId: 'independent-switch-probe', threadId: 'probe-thread' });
  assert.equal(escaped, false);
  resume.resolve(); await first;
  assert.equal((await second).thread.getId(), 'second-thread');
  assert.equal((await runtime.controller.queryThreadById({ threadId: 'first-thread' }))?.title, 'First configured');
});
