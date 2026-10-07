import { fork, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { aggregateBenchmarks, checkTurns, formatBenchmarkMarkdown, measureProcessTree, type BenchmarkHarness, type BenchmarkRequest, type BenchmarkRun, type BenchmarkStage, type BenchmarkTurn, type MemorySample } from './benchmark-summary.js';

const ps = promisify(execFile);
const workerFile = fileURLToPath(import.meta.url);
const prompts = [
  'Do not use any tools. Reply with exactly KODEX_BENCH_OK and nothing else.',
  'Do not use any tools. Reply with exactly KODEX_BENCH_FOLLOWUP and nothing else.',
  'Use your file-reading tools to read numbers.json in the project root. Sum the amount values for entries whose enabled field is true, and count those entries. Reply with only JSON with keys total and count, and no other text.',
];
interface Scenario { name: string; projects: number; chats: number; active: number; prompts: string[]; repetitions: number }
interface WorkerRequest extends BenchmarkRequest { binary?: string; home?: string }
interface WorkerRuntime {
  loadedChats: number;
  run(prompts?: string[], activeChats?: number): Promise<{ turns: BenchmarkTurn[] }>;
  dispose(): Promise<void>;
}
type WorkerMessage = { type: 'loaded'; loadedChats: number } | { type: 'result'; turns: BenchmarkTurn[] }
  | { type: 'stage'; stage: BenchmarkStage } | { type: 'disposed' } | { type: 'failed' };

/** Native workers own runs; this wrapper owns measurement and IPC only. */
async function workerMain(harness: BenchmarkHarness): Promise<void> {
  let runtime: WorkerRuntime | undefined;
  let busy = false;
  const send = (message: WorkerMessage) => { if (process.connected) process.send?.(message); };
  const fail = () => { send({ type: 'failed' }); process.exitCode = 1; };
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (busy) { fail(); return; }
    busy = true;
    void (async () => {
      if (message.type === 'init' && 'request' in message && !runtime) {
        const request = message.request as WorkerRequest;
        const options = { onStage(stage: BenchmarkStage) { if (stage.type !== 'loaded') send({ type: 'stage', stage }); } };
        if (harness === 'mastra') {
          const { createMastraBenchmarkRuntime } = await import('./benchmark-mastra.js');
          runtime = await createMastraBenchmarkRuntime(request, options);
        } else {
          if (!request.binary || !request.home) throw new Error('Missing isolated Codex runtime');
          const { createCodexBenchmarkRuntime } = await import('./benchmark-codex.js');
          runtime = await createCodexBenchmarkRuntime({ ...request, binary: request.binary, home: request.home }, options);
        }
        send({ type: 'loaded', loadedChats: runtime.loadedChats });
      } else if (message.type === 'run' && runtime) {
        send({ type: 'result', ...(await runtime.run()) });
      } else if (message.type === 'dispose') {
        await runtime?.dispose();
        send({ type: 'disposed' });
        // Native CLI semantics: a fresh process per case, never hot-retired for reuse.
        process.disconnect?.();
        process.exit(0);
      } else throw new Error('Invalid benchmark IPC state');
    })().catch(fail).finally(() => { busy = false; });
  });
  // The parent owns this isolated process group and cleans it up on failure.
  process.on('disconnect', () => { process.exit(1); });
}

function inbox(child: ChildProcess) {
  const queued: WorkerMessage[] = [];
  let waiter: { type: WorkerMessage['type']; resolve: (message: WorkerMessage) => void; reject: (error: Error) => void } | undefined;
  let failed = false;
  const fail = () => { failed = true; waiter?.reject(new Error('Benchmark worker failed; raw diagnostics were suppressed')); waiter = undefined; };
  child.on('error', fail);
  child.on('exit', () => { if (waiter) fail(); });
  child.on('message', (message: WorkerMessage) => {
    if (message.type === 'stage') return;
    if (message.type === 'failed') { fail(); return; }
    if (message.type === waiter?.type) { const pending = waiter; waiter = undefined; pending.resolve(message); }
    else queued.push(message);
  });
  return {
    async wait(type: WorkerMessage['type'], timeoutMs: number): Promise<WorkerMessage> {
      if (failed) throw new Error('Benchmark worker failed');
      const index = queued.findIndex(message => message.type === type);
      if (index >= 0) return queued.splice(index, 1)[0]!;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<WorkerMessage>((resolveMessage, reject) => {
          timeout = setTimeout(() => { waiter = undefined; reject(new Error('Benchmark worker timeout')); }, timeoutMs);
          waiter = { type, resolve: resolveMessage, reject };
        });
      } finally { if (timeout) clearTimeout(timeout); }
    },
  };
}

async function sampleMemory(pid: number): Promise<ReturnType<typeof measureProcessTree>> {
  const { stdout } = await ps('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 });
  return measureProcessTree(stdout, pid);
}

async function runCase(harness: BenchmarkHarness, scenario: Scenario, repetition: number): Promise<BenchmarkRun> {
  // Native project detection climbs Git roots: executable fixtures must live outside this repository.
  const caseRoot = await mkdtemp(join(tmpdir(), 'kodex-harness-benchmark-'));
  const projectPaths: string[] = [];
  for (let index = 0; index < scenario.projects; index++) {
    const project = join(caseRoot, `project-${index}`);
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(join(project, 'numbers.json'), JSON.stringify([{ amount: 17, enabled: true }, { amount: 19, enabled: true }, { amount: 6, enabled: true }, { amount: 100, enabled: false }]) + '\n');
    projectPaths.push(project);
  }
  const request: WorkerRequest = {
    projectPaths, runtimeRoot: join(caseRoot, 'runtime'), profileRoot: process.env.KODEX_MASTRA_PROFILE ?? join(homedir(), '.kodex', 'mastra-spike'),
    model: harness === 'mastra' ? process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol' : process.env.KODEX_CODEX_BENCH_MODEL ?? 'gpt-6.1-sol',
    effort: 'low', chatsPerProject: scenario.chats, prompts: scenario.prompts, activeChats: scenario.active,
    ...(harness === 'codex' && { binary: process.env.KODEX_CODEX_BENCH_BINARY ?? '/Users/jtkw/.local/share/kodex/releases/20261007-093421-ef20fba8/codex', home: process.env.KODEX_CODEX_BENCH_HOME ?? join(homedir(), '.kodex', 'mastra-spike', 'app-server-benchmark') }),
  };
  const started = performance.now();
  const child = fork(workerFile, ['--worker', harness], {
    execArgv: ['--import', 'tsx'], detached: true,
    // Deliberately do not persist credential-bearing upstream diagnostics.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env },
  });
  const pid = child.pid;
  if (!pid) throw new Error('Benchmark worker did not start');
  const messages = inbox(child);
  const result: BenchmarkRun = { harness, scenario: scenario.name, repetition, projectCount: scenario.projects, chatsPerProject: scenario.chats, activeChats: scenario.active, promptCount: scenario.prompts.length, loadedChats: 0, startupMs: null, runMs: null, samples: [], turns: [], failures: [] };
  let correctnessChecked = false;
  let phase: MemorySample['phase'] = 'startup';
  let sampling = false;
  let pendingSample: Promise<void> | undefined;
  const sample = () => {
    if (sampling) return pendingSample;
    sampling = true;
    const capturedPhase = phase;
    const elapsedMs = performance.now() - started;
    pendingSample = sampleMemory(pid).then(memory => {
      if (memory) result.samples.push({ ...memory, elapsedMs, phase: capturedPhase });
    }).catch(() => { result.failures.push('RSS measurement failed'); }).finally(() => { sampling = false; });
    return pendingSample;
  };
  const interval = setInterval(() => { void sample(); }, 500);
  try {
    await sample();
    child.send({ type: 'init', request });
    const loaded = await messages.wait('loaded', 180_000);
    if (loaded.type !== 'loaded') throw new Error('Invalid benchmark loaded response');
    result.loadedChats = loaded.loadedChats;
    result.startupMs = performance.now() - started;
    if (loaded.loadedChats !== scenario.projects * scenario.chats) result.failures.push('Loaded chat count mismatch');
    // Explicit measurement warm-settle, not a lifecycle/correctness predicate.
    await pendingSample;
    phase = 'loaded-idle';
    await sample();
    await delay(1_100);
    await sample();
    if (scenario.active > 0) {
      await pendingSample;
      phase = 'active';
      const runStarted = performance.now();
      child.send({ type: 'run' });
      await sample();
      const finished = await messages.wait('result', 600_000);
      if (finished.type !== 'result') throw new Error('Invalid benchmark run response');
      result.runMs = performance.now() - runStarted;
      result.turns = finished.turns;
      await sample();
      correctnessChecked = true;
      result.failures.push(...checkTurns(result.turns, { activeChats: scenario.active, chatsPerProject: scenario.chats, promptCount: scenario.prompts.length, fileTask: scenario.prompts.length === 3 }));
    }
    clearInterval(interval);
    await pendingSample;
    child.send({ type: 'dispose' });
    await messages.wait('disposed', 30_000);
  } catch {
    result.failures.push('Worker initialization, run or native disposal failed/ timed out; raw diagnostics suppressed');
    if (scenario.active > 0 && !correctnessChecked) result.failures.push(...checkTurns(result.turns, { activeChats: scenario.active, chatsPerProject: scenario.chats, promptCount: scenario.prompts.length, fileTask: scenario.prompts.length === 3 }));
  } finally {
    clearInterval(interval);
    await pendingSample;
    // This process group belongs only to the disposable benchmark case.
    try { process.kill(-pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await delay(100);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
    await rm(caseRoot, { recursive: true, force: true });
  }
  if (!result.samples.some(sample => sample.phase === 'loaded-idle')) result.failures.push('No loaded-idle RSS measurement');
  return result;
}

export async function runBenchmarkCli(args: string[]): Promise<number> {
  const readOption = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('node --import tsx src/benchmark.ts [--repetitions 3] [--harness all|mastra|codex] [--only sequential|memory-5|memory-15|concurrent-5] [--output artifacts/benchmark-<timestamp>]');
    return 0;
  }
  const repetitions = Number(readOption('--repetitions') ?? 3);
  const selectedHarness = readOption('--harness') ?? 'all';
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 || !['all', 'mastra', 'codex'].includes(selectedHarness)) throw new Error('Invalid benchmark options');
  const mastraModel = process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol';
  const codexModel = process.env.KODEX_CODEX_BENCH_MODEL ?? 'gpt-6.1-sol';
  if (selectedHarness === 'all' && mastraModel.replace(/^openai\//, '') !== codexModel) throw new Error('Both harnesses must benchmark the same underlying model');
  const outputRoot = resolve(readOption('--output') ?? join('artifacts', `benchmark-${new Date().toISOString().replaceAll(':', '-')}`));
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  if ((await readdir(outputRoot)).length) throw new Error('Benchmark output directory must be fresh and empty');
  const scenarios: Scenario[] = [
    { name: 'sequential', projects: 1, chats: 1, active: 1, prompts, repetitions },
    { name: 'memory-5', projects: 1, chats: 5, active: 0, prompts: [], repetitions: 1 },
    { name: 'memory-15', projects: 3, chats: 5, active: 0, prompts: [], repetitions: 1 },
    { name: 'concurrent-5', projects: 1, chats: 5, active: 5, prompts: prompts.slice(0, 1), repetitions: 1 },
  ];
  const only = readOption('--only');
  if (only && !scenarios.some(scenario => scenario.name === only)) throw new Error('Unknown benchmark scenario');
  const runs: BenchmarkRun[] = [];
  const generatedAt = new Date().toISOString();
  const packages: Record<string, string> = {};
  for (const name of ['@mastra/code-sdk', '@mastra/core', '@mastra/memory', '@mastra/libsql', 'tsx']) {
    const packagePath = join(dirname(dirname(fileURLToPath(import.meta.resolve(name)))), 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
    packages[name] = pkg.version;
  }
  let codexVersion: string | null = null;
  if (selectedHarness !== 'mastra') {
    const binary = process.env.KODEX_CODEX_BENCH_BINARY ?? '/Users/jtkw/.local/share/kodex/releases/20261007-093421-ef20fba8/codex';
    const { stdout } = await ps(binary, ['--version'], { timeout: 10_000, maxBuffer: 8_192 });
    // Versions only, never executable paths or unexpected native diagnostics.
    const reported = stdout.trim();
    if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(reported)) throw new Error('Unexpected benchmark runtime version');
    codexVersion = reported;
  }
  const versions = { node: process.version, packages, codex: codexVersion, platform: process.platform, arch: process.arch };
  const persist = async () => {
    const summary = aggregateBenchmarks(runs);
    await writeFile(join(outputRoot, 'report.json'), JSON.stringify({ generatedAt, versions, samplingIntervalMs: 500, idleSettleMs: 1_100, effort: 'low', models: { mastra: process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol', codex: process.env.KODEX_CODEX_BENCH_MODEL ?? 'gpt-6.1-sol' }, runs, summary }, null, 2) + '\n');
    await writeFile(join(outputRoot, 'summary.md'), formatBenchmarkMarkdown(summary));
    return summary;
  };
  for (const scenario of scenarios.filter(scenario => !only || scenario.name === only)) for (let repetition = 1; repetition <= scenario.repetitions; repetition++) {
    const order: BenchmarkHarness[] = repetition % 2 ? ['mastra', 'codex'] : ['codex', 'mastra'];
    for (const harness of order.filter(harness => selectedHarness === 'all' || harness === selectedHarness)) {
      console.error(`Benchmark ${scenario.name}, repetition ${repetition}, ${harness}`);
      runs.push(await runCase(harness, scenario, repetition));
      await persist();
    }
  }
  console.log(formatBenchmarkMarkdown(await persist()));
  console.log(`Artifacts: ${outputRoot}`);
  return runs.some(run => run.failures.length > 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === workerFile) {
  if (process.argv[2] === '--worker') {
    const harness = process.argv[3];
    if (harness !== 'mastra' && harness !== 'codex') process.exit(1);
    await workerMain(harness);
  } else {
    try { process.exitCode = await runBenchmarkCli(process.argv.slice(2)); }
    catch { console.error('Benchmark failed; raw upstream diagnostics suppressed.'); process.exitCode = 1; }
  }
}
