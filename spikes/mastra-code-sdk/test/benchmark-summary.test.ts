import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateBenchmarks, checkTurns, formatBenchmarkMarkdown, measureProcessTree, statistics, type BenchmarkRun, type BenchmarkTurn } from '../src/benchmark-summary.js';

const turn = (overrides: Partial<BenchmarkTurn> = {}): BenchmarkTurn => ({ projectIndex: 0, chatIndex: 0, promptIndex: 0, firstTextMs: 20, totalMs: 100, inputTokens: 10, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, toolCalls: 0, answer: 'KODEX_BENCH_OK', completed: true, errors: false, ...overrides });
const run = (overrides: Partial<BenchmarkRun> = {}): BenchmarkRun => ({ harness: 'mastra', scenario: 'sequential', repetition: 1, projectCount: 1, chatsPerProject: 1, activeChats: 1, promptCount: 1, loadedChats: 1, startupMs: 5, runMs: 100, samples: [{ elapsedMs: 10, phase: 'loaded-idle', workerMainRssKiB: 100, treeRssKiB: 130, codexRssKiB: 0, processCount: 2, processNames: ['node', 'helper'] }], turns: [turn()], failures: [], ...overrides });

test('statistics preserve even medians and unknown values without inventing zero', () => {
  assert.deepEqual(statistics([9, 1, 3, 7, Number.NaN]), { count: 4, median: 5, min: 1, max: 9 });
  assert.equal(statistics([]), null);
  assert.equal(aggregateBenchmarks([run({ startupMs: null, turns: [], failures: ['worker failed'] })])[0]?.startupMs, null);
});

test('correctness requires every requested turn, native completion and a tool-backed file answer', () => {
  const turns = [turn(), turn({ promptIndex: 1, answer: 'KODEX_BENCH_FOLLOWUP' }), turn({ promptIndex: 2, answer: '{"count":3,"total":42}', toolCalls: 1 })];
  assert.deepEqual(checkTurns(turns, { activeChats: 1, promptCount: 3, chatsPerProject: 1, fileTask: true }), []);
  assert.ok(checkTurns(turns.slice(0, 2), { activeChats: 1, promptCount: 3, chatsPerProject: 1, fileTask: true }).some(reason => reason.includes('missing')));
  assert.ok(checkTurns([turn({ completed: false })], { activeChats: 1, promptCount: 1, chatsPerProject: 1, fileTask: false }).length);
  assert.ok(checkTurns([turns[0]!, turns[1]!, turn({ promptIndex: 2, answer: '{"total":42,"count":3}', toolCalls: 0 })], { activeChats: 1, promptCount: 3, chatsPerProject: 1, fileTask: true }).some(reason => reason.includes('tool')));
  assert.ok(checkTurns([turn(), turn()], { activeChats: 1, promptCount: 1, chatsPerProject: 1, fileTask: false }).some(reason => reason.includes('duplicate')));
});

test('aggregation uses per-run idle medians and peaks, weighted known cache usage, and separates scenarios', () => {
  const a = run({ turns: [turn({ inputTokens: 10, cachedInputTokens: 10 })] });
  const b = run({ repetition: 2, turns: [turn({ inputTokens: 90, cachedInputTokens: 0 }), turn({ chatIndex: 1, inputTokens: 999, cachedInputTokens: null, firstTextMs: null })], samples: [10, 20, 30].map((n, i) => ({ elapsedMs: i, phase: 'loaded-idle' as const, workerMainRssKiB: n, treeRssKiB: n * 2, codexRssKiB: 0, processCount: 1, processNames: ['node'] })), failures: ['fixture failure'] });
  const summary = aggregateBenchmarks([a, b, run({ scenario: 'memory-5', activeChats: 0, promptCount: 0, turns: [] })]);
  assert.equal(summary.length, 2);
  const sequential = summary.find(row => row.scenario === 'sequential')!;
  assert.equal(sequential.idleTreeRssKiB?.median, 85); // median of 130 and 40, not median of every sample
  assert.equal(sequential.firstTextMs?.count, 2);
  assert.equal(sequential.cache.ratio, 0.1);
  assert.equal(sequential.cache.knownUncachedInputTokens, 90);
  assert.equal(sequential.prompts[0]?.promptIndex, 0);
  assert.equal(sequential.prompts[0]?.cache.ratio, 0.1);
  assert.equal(sequential.cache.knownTurns, 2);
  assert.equal(sequential.cache.unknownTurns, 1);
  assert.equal(sequential.failureCount, 1);
  assert.equal(sequential.activePeakTreeRssKiB, null);
  assert.match(formatBenchmarkMarkdown(summary), /unknown/);
});

test('RSS measurement includes descendants and excludes unrelated processes and command arguments', () => {
  const sample = measureProcessTree('10 1 100 /usr/bin/node\n11 10 200 /opt/codex\n12 11 30 /usr/bin/helper\n20 1 999 /private/other\n', 10);
  assert.deepEqual(sample, { workerMainRssKiB: 100, treeRssKiB: 330, codexRssKiB: 200, processCount: 3, processNames: ['codex', 'helper', 'node'] });
  assert.equal(measureProcessTree('20 1 999 other', 10), null);
});

test('initial, follow-up and file task usage/latency stay separately comparable', () => {
  const summary = aggregateBenchmarks([run({ turns: [turn({ inputTokens: 100, cachedInputTokens: 0, totalMs: 400 }), turn({ promptIndex: 1, inputTokens: 120, cachedInputTokens: 100, totalMs: 200 }), turn({ promptIndex: 2, inputTokens: 180, cachedInputTokens: null, totalMs: 900 })] })])[0]!;
  assert.deepEqual(summary.prompts.map(prompt => prompt.totalMs?.median), [400, 200, 900]);
  assert.deepEqual(summary.prompts.map(prompt => prompt.inputTokens), [100, 120, 180]);
  assert.equal(summary.prompts[1]?.cache.knownUncachedInputTokens, 20);
  assert.equal(summary.prompts[2]?.cache.ratio, null);
});

test('driver launches a fresh native worker, samples loaded/active memory and saves sanitized local-fixture results', { timeout: 30_000 }, async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { activateProfile, resolveProfile } = await import('../src/profile.js');
  const { runBenchmarkCli } = await import('../src/benchmark.js');
  const { lastUserText, startModelFixture } = await import('./fixtures/model-server.js');
  const root = await mkdtemp(join(tmpdir(), 'kodex-benchmark-driver-test-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture(request => {
    const text = lastUserText(request);
    if (text.includes('numbers.json')) {
      if (request.messages.at(-1)?.role === 'tool') return { text: '{"total":42,"count":3}' };
      const tool = request.tools?.find(tool => tool.function.name === 'view');
      assert.ok(tool);
      return { toolCalls: [{ name: tool.function.name, arguments: { path: 'numbers.json' } }] };
    }
    return { text: text.includes('KODEX_BENCH_FOLLOWUP') ? 'KODEX_BENCH_FOLLOWUP' : 'KODEX_BENCH_OK' };
  });
  const oldProfile = process.env.KODEX_MASTRA_PROFILE;
  const oldModel = process.env.KODEX_MASTRA_MODEL;
  const oldApp = process.env.MASTRA_APP_DATA_DIR;
  const oldDb = process.env.MASTRA_DB_PATH;
  t.after(async () => {
    for (const [key, value] of Object.entries({ KODEX_MASTRA_PROFILE: oldProfile, KODEX_MASTRA_MODEL: oldModel, MASTRA_APP_DATA_DIR: oldApp, MASTRA_DB_PATH: oldDb })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(profile.settingsPath, JSON.stringify({ customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }], models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/chat' }, observability: { enabled: false } }));
  process.env.KODEX_MASTRA_PROFILE = profile.root;
  process.env.KODEX_MASTRA_MODEL = 'fixture/chat';
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const output = join(root, 'reports');
  assert.equal(await runBenchmarkCli(['--harness', 'mastra', '--only', 'sequential', '--repetitions', '1', '--output', output]), 0);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.versions.packages['@mastra/code-sdk'], '1.10.1');
  assert.equal(report.versions.codex, null);
  assert.equal(report.runs.length, 1);
  const measured = report.runs[0] as BenchmarkRun;
  assert.equal(measured.loadedChats, 1);
  assert.equal(measured.turns.length, 3);
  assert.deepEqual(measured.failures, []);
  assert.ok(measured.samples.some(sample => sample.phase === 'loaded-idle' && sample.workerMainRssKiB > 0));
  assert.ok(measured.samples.some(sample => sample.phase === 'active' && sample.treeRssKiB >= sample.workerMainRssKiB));
  assert.equal(measured.turns[2]?.toolCalls, 1);
  assert.equal(JSON.stringify(report).includes('fixture-no-real-credential'), false);
});
