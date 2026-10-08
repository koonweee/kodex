import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-subagents-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => {
    const task = lastUserText(request);
    const serialized = JSON.stringify(request.messages);
    const forked = task.includes('FORKED');
    const mode = forked ? 'FORKED' : 'DEFAULT';
    if (task.includes('CHILD_TASK_')) {
      if (serialized.includes('CHILD_FILE_EVIDENCE')) return { text: `CHILD_RESULT_${mode}` };
      assert.ok(request.tools?.some(tool => tool.function.name === 'view'), 'real child has the public workspace view tool');
      return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: `child-view-${mode}` }] };
    }
    if (serialized.includes(`CHILD_RESULT_${mode}`)) return { text: `PARENT_RESULT_${mode}` };
    assert.ok(request.tools?.some(tool => tool.function.name === 'subagent'), 'real parent has the native subagent tool');
    return { toolCalls: [{ name: 'subagent', arguments: {
      agentType: 'explore', task: `CHILD_TASK_${mode}: inspect evidence.txt and return a concise result.`,
      ...(forked && { forked: true }),
    }, id: `parent-subagent-${mode}` }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, subagentModels: { default: 'fixture/chat' },
      observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

for (const forked of [false, true]) {
  const mode = forked ? 'FORKED' : 'DEFAULT';
  test(`real native ${mode.toLowerCase()} subagent exposes live activity and characterizes persisted child history`, { timeout: 40_000 }, async t => {
    const projectPath = join(root, mode);
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'evidence.txt'), 'CHILD_FILE_EVIDENCE: real child tool output, distinct from its final result.');
    // No subagent override: exercise CodeSDK's standard explore definition.
    const options = { profile, projectPath, runtimeRoot: join(root, `${mode}-runtime`),
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
    let runtime = await createProjectRuntime(options);
    t.after(() => runtime.dispose());
    const target = { threadId: `parent-${mode}`, resourceId: `resource-${mode}` };
    const session = await runtime.createSession(target);
    await session.thread.rename({ title: `Subagent ${mode} fixture`, pin: true });
    const events: AgentControllerEvent[] = [];
    const displays: Array<{ status: string; textDelta: string; result?: string; toolCalls: Array<{ name: string; isError: boolean }> }> = [];
    const off = session.subscribe(event => {
      if (event.type.startsWith('subagent_')) events.push(event);
      if (event.type === 'display_state_changed') {
        const child = event.displayState.activeSubagents.get(`parent-subagent-${mode}`);
        if (child) displays.push({ status: child.status, textDelta: child.textDelta, result: child.result,
          toolCalls: child.toolCalls.map(call => ({ ...call })) });
      }
    });
    t.after(off);
    const requestStart = fixture.requests.length;
    await session.sendMessage({ content: `PARENT_TASK_${mode}: delegate the file inspection.` });
    const childRequest = fixture.requests.slice(requestStart).find(request => lastUserText(request).includes(`CHILD_TASK_${mode}`));
    assert.ok(childRequest, 'the fixture receives a real native child model request');
    assert.equal(JSON.stringify(childRequest.messages).includes(`PARENT_TASK_${mode}`), forked,
      'default delegation has fresh context; forked delegation inherits the parent conversation');
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
    assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
    await memory.settled();
    const start = events.find(event => event.type === 'subagent_start');
    assert.ok(start?.type === 'subagent_start');
    assert.equal(start.forked, forked);
    assert.equal(start.agentType, 'explore');
    assert.equal(start.toolCallId, `parent-subagent-${mode}`);
    assert.ok(events.some(event => event.type === 'subagent_text_delta' && event.textDelta.includes(`CHILD_RESULT_${mode}`)));
    assert.ok(events.some(event => event.type === 'subagent_tool_start' && event.subToolName === 'view'));
    assert.ok(events.some(event => event.type === 'subagent_tool_end' && !event.isError && JSON.stringify(event.subToolResult).includes('CHILD_FILE_EVIDENCE')));
    assert.ok(events.some(event => event.type === 'subagent_end' && !event.isError && event.result === `CHILD_RESULT_${mode}`));
    assert.ok(displays.some(display => display.status === 'running'), 'canonical live display exposes active child');
    assert.ok(displays.some(display => display.status === 'completed' && display.result === `CHILD_RESULT_${mode}`
      && display.toolCalls.some(call => call.name === 'view' && !call.isError)), 'canonical display retains completion and subtool summary');

    const readParent = async () => (await runtime.controller.queryThreadMessages({ ...target, perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
    const parentBefore = await readParent();
    const persistedSubagentCall = parentBefore.flatMap(message => message.content.parts).find(part =>
      part.type === 'tool-invocation' && part.toolInvocation.toolName === 'subagent' && part.toolInvocation.state === 'result');
    assert.ok(persistedSubagentCall?.type === 'tool-invocation');
    assert.equal(persistedSubagentCall.toolInvocation.toolCallId, `parent-subagent-${mode}`);
    assert.ok(JSON.stringify(persistedSubagentCall.toolInvocation.result).includes(`CHILD_RESULT_${mode}`), 'parent persists native subagent result');
    assert.ok(JSON.stringify(parentBefore).includes(`PARENT_RESULT_${mode}`));
    assert.ok(!JSON.stringify(parentBefore).includes('CHILD_FILE_EVIDENCE'), 'parent result does not contain the full child file-read transcript');
    const childrenBefore = await runtime.controller.queryThreads({ includeForkedSubagents: true, metadata: { parentThreadId: target.threadId } });
    assert.equal(childrenBefore.length, forked ? 1 : 0);
    const inventoryBefore = await runtime.controller.queryThreads({ includeForkedSubagents: true });
    assert.equal(inventoryBefore.length, forked ? 2 : 1, 'default run leaves no separately persisted child thread');

    await runtime.dispose();
    runtime = await createProjectRuntime(options);
    let activations = 0;
    const offCreated = runtime.controller.onSessionCreated(() => { activations++; });
    t.after(offCreated);
    const requestCount = fixture.requests.length;
    const parentAfter = await readParent();
    assert.deepEqual(parentAfter, parentBefore, 'parent result survives native runtime restart');
    const childrenAfter = await runtime.controller.queryThreads({ includeForkedSubagents: true, metadata: { parentThreadId: target.threadId } });
    assert.deepEqual(childrenAfter.map(child => child.id), childrenBefore.map(child => child.id));
    assert.equal((await runtime.controller.queryThreads({ includeForkedSubagents: true })).length, forked ? 2 : 1);
    if (forked) {
      const child = childrenAfter[0]!;
      assert.equal(child.metadata?.forkedSubagent, true);
      assert.equal(child.metadata?.parentThreadId, target.threadId);
      assert.ok(!(await runtime.controller.queryThreads({})).some(thread => thread.id === child.id), 'ordinary native listing hides forked children');
      const transcript = (await runtime.controller.queryThreadMessages({ threadId: child.id, resourceId: child.resourceId,
        perPage: false, orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
      assert.ok(JSON.stringify(transcript).includes(`PARENT_TASK_${mode}`), 'fork retains parent conversation');
      assert.ok(JSON.stringify(transcript).includes(`CHILD_TASK_${mode}`));
      assert.ok(JSON.stringify(transcript).includes('CHILD_FILE_EVIDENCE'), 'full child tool result survives restart');
      assert.ok(JSON.stringify(transcript).includes(`CHILD_RESULT_${mode}`), 'full child assistant result survives restart');
    }
    assert.equal(activations, 0, 'read-only parent/child discovery and transcript reads never activate sessions');
    assert.equal(fixture.requests.length, requestCount, 'post-restart reads never invoke the model');
  });
}
