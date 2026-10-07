import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('compiled benchmark launches plain-JavaScript workers and repeats idle cases without model turns', { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-benchmark-build-'));
  // Keep emitted imports below the package so installed dependencies resolve.
  await mkdir('artifacts', { recursive: true });
  const buildRoot = await mkdtemp(join('artifacts', 'benchmark-build-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  });
  const compiler = join(dirname(fileURLToPath(import.meta.resolve('typescript'))), 'tsc.js');
  await execute(process.execPath, [compiler, '--project', 'tsconfig.build.json', '--outDir', buildRoot]);
  const entrypoint = join(buildRoot, 'benchmark.js');
  await execute(process.execPath, [entrypoint, '--help']);
  const profile = join(root, 'profile');
  // Native profile validation requires its initial root to be empty; settings
  // are supplied after initialization by a short dedicated child.
  const profileBootstrap = join(buildRoot, 'profile.js');
  await execute(process.execPath, ['--input-type=module', '-e', `
    import { activateProfile, resolveProfile } from ${JSON.stringify(new URL(profileBootstrap, new URL('../', import.meta.url)).href)};
    import { writeFile } from 'node:fs/promises';
    const profile = activateProfile(resolveProfile(process.argv[1]));
    await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
  `, profile]);
  const capturePath = join(root, 'launches.jsonl');
  const preload = join(root, 'capture.cjs');
  await writeFile(preload, String.raw`require('node:fs').appendFileSync(process.env.KODEX_BENCH_LAUNCH_LOG, JSON.stringify({ argv: process.argv, execArgv: process.execArgv }) + '\n');`);
  const output = join(root, 'reports');
  await execute(process.execPath, [entrypoint, '--harness', 'mastra', '--only', 'memory-1', '--memory-repetitions', '2', '--output', output], {
    env: { ...process.env, KODEX_MASTRA_PROFILE: profile, KODEX_BENCH_LAUNCH_LOG: capturePath, NODE_OPTIONS: `--require=${preload}` },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.executionMode, 'compiled-js');
  assert.deepEqual(report.runs.map((run: { repetition: number }) => run.repetition), [1, 2]);
  for (const run of report.runs) {
    assert.equal(run.loadedChats, 1);
    assert.deepEqual(run.turns, []);
    assert.deepEqual(run.failures, []);
    assert.ok(run.samples.some((sample: { phase: string; treeRssKiB: number }) => sample.phase === 'loaded-idle' && sample.treeRssKiB > 0));
  }
  const launches = (await readFile(capturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; execArgv: string[] });
  const workers = launches.filter(launch => launch.argv.includes('--worker'));
  assert.equal(workers.length, 2, 'each repetition uses a fresh measured process');
  for (const worker of workers) assert.deepEqual(worker.execArgv, [], 'compiled workers do not retain a TypeScript loader');
});
