import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createMastraBenchmarkRuntime, type MastraBenchmarkStage } from '../src/benchmark-mastra.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

test('benchmark loads idle chats, selects first N, and reports per-turn native usage including tool steps', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-mastra-benchmark-test-'));
  const profile = activateProfile(resolveProfile(path.join(root, 'profile')));
  const fixture = await startModelFixture(request => {
    if (lastUserText(request).includes('READ_MARKER') && request.messages.at(-1)?.role !== 'tool') {
      const tool = request.tools?.find(tool => tool.function.name === 'view');
      assert.ok(tool);
      return { text: 'BENCHMARK_TOOL_PREFACE', toolCalls: [{ name: tool.function.name, arguments: { path: 'marker.txt' } }] };
    }
    return { text: `fixture:${lastUserText(request)}` };
  });
  // Add optional usage to only the non-tool step; omit it from the tool-result
  // step to prove that partial reporting is not presented as a complete tally.
  const proxy = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch(`${fixture.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    const omitUsage = lastUserText(input).includes('OMIT_USAGE') || (lastUserText(input).includes('OMIT_TOOL_USAGE') && input.messages.at(-1)?.role === 'tool');
    const body = (await upstream.text()).split('\n').map(line => {
      if (!line.startsWith('data: {')) return line;
      const chunk = JSON.parse(line.slice(6));
      if (!chunk.usage) return line;
      if (omitUsage) return '';
      if (input.messages.at(-1)?.role !== 'tool') {
        chunk.usage.prompt_tokens_details = { cached_tokens: 5 };
        chunk.usage.completion_tokens_details = { reasoning_tokens: 1 };
      }
      return `data: ${JSON.stringify(chunk)}`;
    }).join('\n');
    response.writeHead(upstream.status, { 'content-type': 'text/event-stream' });
    response.end(body);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  const proxyUrl = `http://127.0.0.1:${address.port}/v1`;
  let benchmark: Awaited<ReturnType<typeof createMastraBenchmarkRuntime>> | undefined;
  try {
    const settings = JSON.stringify({
      models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/chat' },
      customProviders: [{ name: 'fixture', url: proxyUrl, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
      observability: { enabled: false },
    });
    await writeFile(profile.settingsPath, settings);
    const projectPaths = [path.join(root, 'project-A'), path.join(root, 'project-B')];
    for (const project of projectPaths) {
      await mkdir(project);
      await writeFile(path.join(project, 'marker.txt'), 'BENCHMARK_MARKER');
    }
    const stages: MastraBenchmarkStage[] = [];
    benchmark = await createMastraBenchmarkRuntime({ projectPaths, runtimeRoot: path.join(root, 'runtime'), profileRoot: profile.root, model: 'fixture/chat', effort: 'low', chatsPerProject: 2, prompts: ['FIRST', 'READ_MARKER'], activeChats: 3 }, { onStage: stage => { stages.push(stage); } });
    assert.equal(benchmark.loadedChats, 4);
    assert.equal(fixture.requests.length, 0, 'loading chats is idle and does not call a provider');
    assert.equal(stages.filter(stage => stage.type === 'loaded').length, 1);
    // Native SDK loadSettings normalizes the file on mount. Benchmark turns must
    // preserve that native result, including configured observer/judge models.
    const mountedSettings = await readFile(profile.settingsPath, 'utf8');
    const nativeSettings = JSON.parse(mountedSettings);
    assert.equal(nativeSettings.models.observerModelOverride, 'fixture/chat');
    assert.equal(nativeSettings.models.reflectorModelOverride, 'fixture/chat');
    assert.equal(nativeSettings.models.goalJudgeModel, 'fixture/chat');
    const report = await benchmark.run();
    assert.equal(report.turns.length, 6);
    assert.deepEqual([...new Set(report.turns.map(turn => `${turn.projectIndex}/${turn.chatIndex}`))], ['0/0', '0/1', '1/0'], 'only the first three flattened chats run across projects');
    for (const turn of report.turns) {
      assert.equal(turn.completed, true);
      assert.equal(turn.errors, false);
      assert.ok(turn.firstTextMs !== null && turn.firstTextMs >= 0 && turn.firstTextMs <= turn.totalMs);
      assert.match(turn.answer, /^fixture:/, 'only the final answer is graded, excluding pre-tool commentary');
      assert.doesNotMatch(turn.answer, /BENCHMARK_TOOL_PREFACE/);
      assert.equal(turn.inputTokens, turn.promptIndex === 0 ? 10 : 20, 'usage is per-turn, not thread cumulative, and includes both tool model steps');
      assert.equal(turn.outputTokens, turn.promptIndex === 0 ? 3 : 6);
      assert.equal(turn.toolCalls, turn.promptIndex === 0 ? 0 : 1);
      assert.equal(turn.cachedInputTokens, turn.promptIndex === 0 ? 5 : null, 'optional usage requires complete coverage of every model step');
      assert.equal(turn.reasoningTokens, turn.promptIndex === 0 ? 1 : null);
    }
    assert.equal(stages.filter(stage => stage.type === 'turnStart').length, 6);
    assert.equal(stages.filter(stage => stage.type === 'turnEnd').length, 6);
    assert.equal(await readFile(profile.settingsPath, 'utf8'), mountedSettings, 'benchmark turns preserve native mounted settings');
    const missing = (await benchmark.run(['OMIT_USAGE'], 1)).turns[0]!;
    assert.equal(missing.errors, true, 'missing provider usage is not graded as a successful free turn');
    assert.equal(missing.completed, false);
    const partial = (await benchmark.run(['READ_MARKER OMIT_TOOL_USAGE'], 1)).turns[0]!;
    assert.equal(partial.inputTokens, 10, 'the first model step was measured');
    assert.equal(partial.errors, true, 'a missing final model-step usage invalidates an otherwise positive partial tally');
    assert.equal(partial.completed, false);
  } finally {
    await benchmark?.dispose();
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
