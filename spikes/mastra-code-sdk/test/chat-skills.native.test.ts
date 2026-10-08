import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSkillPaths } from '@mastra/code-sdk/agents/workspace';
import { expandSkillCommand, listSkillCommands } from '@mastra/code-sdk/acp/skills';
import { formatSkillActivation, LocalSkillSource, Workspace } from '@mastra/core/workspace';
import { captureChatFastRequestContext } from '../src/chat-fast.js';
import { readChatHistory } from '../src/chat-history.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function skill(root: string, directory: string, name: string, body: string, userInvocable = true) {
  const path = join(root, directory, 'skills', name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Native fixture ${name}.\nuser-invocable: ${userInvocable}\n---\n\n${body}\n`);
  return path;
}

test('native draft skill discovery, exact-path activation and formatted instructions preserve native persistence and replay', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-skills-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project-a'), peerProject = join(root, 'project-b');
  await Promise.all([mkdir(projectPath), mkdir(peerProject)]);
  const global = await skill(profile.homeDir, '.agents', 'profile-global', 'PROFILE_GLOBAL');
  const selectedPath = await skill(projectPath, '.kodex-mastra-spike', 'same-name', 'SELECTED_NATIVE_SKILL_A');
  const duplicatePath = await skill(projectPath, '.claude', 'same-name', 'DUPLICATE_NATIVE_SKILL_A');
  const hiddenPath = await skill(projectPath, '.agents', 'model-only', 'MODEL_ONLY', false);
  const peerPath = await skill(peerProject, '.agents', 'project-b', 'PEER_PROJECT');
  const outsidePath = await skill(join(root, 'outside-home'), '.agents', 'outside-home', 'OUTSIDE_HOME');
  await mkdir(join(selectedPath, 'references')); await writeFile(join(selectedPath, 'references', 'notes.md'), 'REFERENCE_BODY');
  await mkdir(join(selectedPath, 'scripts')); await writeFile(join(selectedPath, 'scripts', 'run.sh'), 'echo fixture');
  await mkdir(join(selectedPath, 'assets')); await writeFile(join(selectedPath, 'assets', 'sample.txt'), 'asset');
  const fixture = await startModelFixture(request => ({ text: `RECEIVED:${lastUserText(request).includes('SELECTED_NATIVE_SKILL_A') ? 'SELECTED_SKILL' : lastUserText(request)}` }));
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true, subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
  const producers = new Map<string, ReturnType<typeof deferred>>(), sessions = new Set<NativeSession>();
  let runtime: ProjectRuntime;
  let activations = 0;
  async function open() {
    runtime = await createProjectRuntime(options);
    runtime.controller.onSessionCreated(session => { sessions.add(session); activations++; });
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Test-only passthrough observation joins native producers before storage close.
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
    });
  }
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  const catalogs = [projectPath, peerProject].map(cwd => new Workspace({
    skills: () => buildSkillPaths(cwd, '.kodex-mastra-spike', profile.homeDir),
    skillSource: new LocalSkillSource({ basePath: cwd }),
  }));
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await runtime?.dispose();
    for (const catalog of catalogs) await catalog.destroy();
    await fixture.close(); await rm(root, { recursive: true, force: true });
  });
  await open();
  const skills = catalogs[0]!.skills; assert.ok(skills);
  const list = await skills.list();
  assert.deepEqual(list.map(value => value.path).sort(), [global, selectedPath, duplicatePath, hiddenPath].sort());
  assert.deepEqual((await catalogs[1]!.skills!.list()).map(value => value.path).sort(), [global, peerPath].sort());
  assert.equal(list.some(value => value.path === outsidePath), false);
  assert.equal((await skills.get(selectedPath))?.instructions, 'SELECTED_NATIVE_SKILL_A');
  assert.equal((await skills.get(`${duplicatePath}/SKILL.md`))?.instructions, 'DUPLICATE_NATIVE_SKILL_A');
  assert.equal(list.find(value => value.path === hiddenPath)?.['user-invocable'], false, 'model-only skills remain natively discoverable');
  const commands = await listSkillCommands(skills);
  assert.equal(commands.filter(command => command.name === 'skill/same-name').length, 1, 'ACP commands deduplicate by name; selected paths can disambiguate');
  assert.equal(commands.some(command => command.name === 'skill/model-only'), false);
  await assert.rejects(expandSkillCommand('/skill/model-only', skills, commands));
  const nativeHidden = await skills.get(hiddenPath); assert.ok(nativeHidden);
  assert.equal(nativeHidden.instructions, 'MODEL_ONLY', 'user-invocable is not a native model-access prohibition');
  await skill(projectPath, '.agents', 'added-after-list', 'NEW_ON_REFRESH');
  await skill(projectPath, '.claude', 'same-name', 'UPDATED_DUPLICATE');
  await skills.refresh();
  assert.ok((await skills.list()).some(value => value.name === 'added-after-list'));
  assert.equal((await skills.get(duplicatePath))?.instructions, 'UPDATED_DUPLICATE');
  assert.equal(catalogs[0]!.filesystem, undefined); assert.equal(catalogs[0]!.sandbox, undefined);
  assert.equal(activations, 0); assert.equal(fixture.requests.length, 0);
  assert.deepEqual(await runtime!.controller.queryThreads({ metadata: { projectPath } }), [], 'draft discovery creates no native history');

  const target = { threadId: 'skill-chat', resourceId: 'skill-resource' };
  const session = await runtime!.createSession(target); await session.thread.rename({ title: 'Skill proof', pin: true });
  const mounted = session.getWorkspace()?.skills; assert.ok(mounted);
  const selected = await mounted.get(selectedPath); assert.ok(selected);
  const formatted = formatSkillActivation(selected);
  assert.ok(formatted.startsWith(selected.instructions));
  for (const path of ['references/notes.md', 'scripts/run.sh', 'assets/sample.txt']) assert.ok(formatted.includes(path));
  const expanded = await expandSkillCommand('/skill/same-name Review native behavior', mounted, await listSkillCommands(mounted));
  assert.ok(expanded.includes(formatSkillActivation((await mounted.get((await mounted.list()).find(value => value.name === 'same-name')!.path))!)));
  assert.match(expanded, /ARGUMENTS: Review native behavior/);
  const originalText = 'Review 🧪 $same-name';
  // This characterizes supported host composition, not a native skill input-part.
  const contents = `${originalText}\n\n<skill name="${selected.name}">\n${formatted}\n</skill>`;
  const metadata = { clientId: 'skill-client', originalText, selectedSkills: [{ name: selected.name, path: selected.path, start: 10, end: 20 }] };
  const ended = deferred(); const off = session.subscribe(event => { if (event.type === 'agent_end') ended.resolve(); }); t.after(off);
  const signal = session.sendSignal({ type: 'user', contents, metadata }, { requireDelivery: true,
    requestContext: await captureChatFastRequestContext(session), untilIdle: false });
  assert.equal((await signal.accepted).action, 'wake'); await ended.promise; await settled();
  const sent = fixture.requests.find(request => lastUserText(request).includes(originalText)); assert.ok(sent);
  assert.equal(lastUserText(sent), contents);
  assert.equal(JSON.stringify(sent.messages).includes('DUPLICATE_NATIVE_SKILL_A'), false);
  assert.equal(JSON.stringify(sent.messages).includes('UPDATED_DUPLICATE'), false);
  assert.equal(JSON.stringify(sent.messages).includes('skill-client'), false);
  const saved = await readChatHistory(runtime!.controller, target);
  const user = saved.messages.find(message => message.id === signal.id); assert.ok(user);
  assert.equal(user.content.parts.filter(part => part.type === 'text').map(part => part.text).join(''), contents);
  assert.deepEqual((user.content.metadata?.signal as { metadata?: unknown }).metadata, metadata);

  await runtime!.dispose(); await open();
  const beforeActivations = activations, beforeRequests = fixture.requests.length;
  const restored = await readChatHistory(runtime!.controller, target);
  assert.deepEqual(restored.messages.find(message => message.id === signal.id), user);
  assert.equal(activations, beforeActivations); assert.equal(fixture.requests.length, beforeRequests);
  assert.equal(await runtime!.controller.getSessionByResource(target.resourceId), undefined);
  await rm(selectedPath, { recursive: true });
  const reopened = await runtime!.createSession(target);
  await reopened.sendMessage({ content: 'REPLAY_PERSISTED_SKILL', untilIdle: false }); await settled();
  const replay = fixture.requests.find(request => lastUserText(request) === 'REPLAY_PERSISTED_SKILL'); assert.ok(replay);
  assert.ok(replay.messages.some(message => message.role === 'user' && lastUserText({ model: replay.model, messages: [message] }) === contents),
    'persisted activation is replayed without the original skill directory');
  assert.equal(activations, beforeActivations + 1, 'only explicit reopening activates native Session');
});
