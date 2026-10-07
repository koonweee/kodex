import { basename } from 'node:path';

export type BenchmarkHarness = 'mastra' | 'codex';
export interface BenchmarkRequest {
  projectPaths: string[];
  runtimeRoot: string;
  profileRoot?: string;
  model: string;
  effort: 'low';
  chatsPerProject: number;
  prompts: string[];
  activeChats: number;
}
export interface BenchmarkTurn {
  projectIndex: number;
  chatIndex: number;
  promptIndex: number;
  firstTextMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  toolCalls: number;
  answer: string;
  completed: boolean;
  errors: boolean;
}
export type BenchmarkStage = { type: 'loaded'; loadedChats: number }
  | { type: 'turnStart'; projectIndex: number; chatIndex: number; promptIndex: number }
  | { type: 'turnEnd'; projectIndex: number; chatIndex: number; promptIndex: number; report: BenchmarkTurn };
export interface ProcessMemory {
  workerMainRssKiB: number;
  treeRssKiB: number;
  codexRssKiB: number;
  processCount: number;
  processNames: string[];
}
export interface MemorySample extends ProcessMemory {
  elapsedMs: number;
  phase: 'startup' | 'loaded-idle' | 'active';
}
export interface BenchmarkRun {
  harness: BenchmarkHarness;
  scenario: string;
  repetition: number;
  projectCount: number;
  chatsPerProject: number;
  activeChats: number;
  promptCount: number;
  loadedChats: number;
  startupMs: number | null;
  runMs: number | null;
  samples: MemorySample[];
  turns: BenchmarkTurn[];
  failures: string[];
}
export interface Statistics { count: number; median: number; min: number; max: number }
export function statistics(values: number[]): Statistics | null {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return { count: ordered.length, median: ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2, min: ordered[0]!, max: ordered.at(-1)! };
}

/** ps uses comm, never args: names cannot contain OAuth URLs or prompt text. */
export function measureProcessTree(table: string, workerPid: number): ProcessMemory | null {
  const processes = table.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]), name: basename(match[4]!) }] : [];
  });
  const root = processes.find(process => process.pid === workerPid);
  if (!root) return null;
  const included = new Set([workerPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (included.has(process.parent) && !included.has(process.pid)) { included.add(process.pid); changed = true; }
  }
  const tree = processes.filter(process => included.has(process.pid));
  return { workerMainRssKiB: root.rss, treeRssKiB: tree.reduce((n, process) => n + process.rss, 0), codexRssKiB: tree.filter(process => process.pid !== workerPid && process.name === 'codex').reduce((n, process) => n + process.rss, 0), processCount: tree.length, processNames: [...new Set(tree.map(process => process.name))].sort() };
}

export function checkTurns(turns: BenchmarkTurn[], expected: { activeChats: number; chatsPerProject: number; promptCount: number; fileTask: boolean }): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const key = `${turn.projectIndex}/${turn.chatIndex}/${turn.promptIndex}`;
    const flatChat = turn.projectIndex * expected.chatsPerProject + turn.chatIndex;
    if (seen.has(key)) failures.push(`duplicate turn ${key}`);
    seen.add(key);
    if (turn.projectIndex < 0 || turn.chatIndex < 0 || turn.chatIndex >= expected.chatsPerProject || flatChat >= expected.activeChats || turn.promptIndex < 0 || turn.promptIndex >= expected.promptCount) failures.push(`unexpected turn ${key}`);
    if (!turn.completed || turn.errors) failures.push(`native completion failed ${key}`);
    const answer = turn.answer.trim();
    if (turn.promptIndex === 0 && answer !== 'KODEX_BENCH_OK') failures.push(`sentinel mismatch ${key}`);
    if (turn.promptIndex === 1 && answer !== 'KODEX_BENCH_FOLLOWUP') failures.push(`follow-up mismatch ${key}`);
    if (turn.promptIndex === 2 && expected.fileTask) {
      let correct = false;
      try {
        const parsed: unknown = JSON.parse(answer);
        correct = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 2 && 'total' in parsed && parsed.total === 42 && 'count' in parsed && parsed.count === 3;
      } catch { /* Failure is recorded below, without raw model diagnostics. */ }
      if (!correct) failures.push(`file answer mismatch ${key}`);
      if (!(turn.toolCalls > 0)) failures.push(`file task had no tool call ${key}`);
    }
  }
  for (let chat = 0; chat < expected.activeChats; chat++) for (let prompt = 0; prompt < expected.promptCount; prompt++) {
    const key = `${Math.floor(chat / expected.chatsPerProject)}/${chat % expected.chatsPerProject}/${prompt}`;
    if (!seen.has(key)) failures.push(`missing turn ${key}`);
  }
  return failures;
}

export interface TurnAggregate {
  turnCount: number;
  firstTextMs: Statistics | null;
  totalMs: Statistics | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningKnownTurns: number;
  cache: { knownTurns: number; unknownTurns: number; knownInputTokens: number; cachedInputTokens: number; knownUncachedInputTokens: number; ratio: number | null };
}
function aggregateTurns(turns: BenchmarkTurn[]): TurnAggregate {
  const knownCache = turns.filter(turn => turn.cachedInputTokens !== null && Number.isFinite(turn.cachedInputTokens) && Number.isFinite(turn.inputTokens) && turn.inputTokens >= 0 && turn.cachedInputTokens! >= 0 && turn.cachedInputTokens! <= turn.inputTokens);
  const knownInputTokens = knownCache.reduce((n, turn) => n + turn.inputTokens, 0);
  const cachedInputTokens = knownCache.reduce((n, turn) => n + turn.cachedInputTokens!, 0);
  const reasoning = turns.filter(turn => turn.reasoningTokens !== null && Number.isFinite(turn.reasoningTokens));
  return {
    turnCount: turns.length,
    firstTextMs: statistics(turns.flatMap(turn => turn.firstTextMs === null ? [] : [turn.firstTextMs])), totalMs: statistics(turns.map(turn => turn.totalMs)),
    inputTokens: turns.reduce((n, turn) => n + turn.inputTokens, 0), outputTokens: turns.reduce((n, turn) => n + turn.outputTokens, 0), reasoningTokens: reasoning.reduce((n, turn) => n + turn.reasoningTokens!, 0), reasoningKnownTurns: reasoning.length,
    cache: { knownTurns: knownCache.length, unknownTurns: turns.length - knownCache.length, knownInputTokens, cachedInputTokens, knownUncachedInputTokens: knownInputTokens - cachedInputTokens, ratio: knownInputTokens > 0 ? cachedInputTokens / knownInputTokens : null },
  };
}
export interface BenchmarkAggregate extends TurnAggregate {
  harness: BenchmarkHarness;
  scenario: string;
  runCount: number;
  failureCount: number;
  memorySampleCount: number;
  startupMs: Statistics | null;
  runMs: Statistics | null;
  idleWorkerRssKiB: Statistics | null;
  idleTreeRssKiB: Statistics | null;
  idleCodexRssKiB: Statistics | null;
  activePeakWorkerRssKiB: Statistics | null;
  activePeakTreeRssKiB: Statistics | null;
  activePeakCodexRssKiB: Statistics | null;
  prompts: Array<TurnAggregate & { promptIndex: number }>;
}
export function aggregateBenchmarks(runs: BenchmarkRun[]): BenchmarkAggregate[] {
  const groups = new Map<string, BenchmarkRun[]>();
  for (const run of runs) { const key = `${run.scenario}/${run.harness}`; const group = groups.get(key) ?? []; group.push(run); groups.set(key, group); }
  return [...groups.values()].map(group => {
    const turns = group.flatMap(run => run.turns);
    const memory = (phase: MemorySample['phase'], field: keyof ProcessMemory, peak: boolean) => statistics(group.flatMap(run => {
      const values = run.samples.filter(sample => sample.phase === phase).map(sample => sample[field] as number);
      const stats = statistics(values);
      return stats ? [peak ? stats.max : stats.median] : [];
    }));
    return {
      ...aggregateTurns(turns), harness: group[0]!.harness, scenario: group[0]!.scenario, runCount: group.length, failureCount: group.reduce((n, run) => n + run.failures.length, 0), memorySampleCount: group.reduce((n, run) => n + run.samples.length, 0),
      startupMs: statistics(group.flatMap(run => run.startupMs === null ? [] : [run.startupMs])), runMs: statistics(group.flatMap(run => run.runMs === null ? [] : [run.runMs])),
      idleWorkerRssKiB: memory('loaded-idle', 'workerMainRssKiB', false), idleTreeRssKiB: memory('loaded-idle', 'treeRssKiB', false), idleCodexRssKiB: memory('loaded-idle', 'codexRssKiB', false),
      activePeakWorkerRssKiB: memory('active', 'workerMainRssKiB', true), activePeakTreeRssKiB: memory('active', 'treeRssKiB', true), activePeakCodexRssKiB: memory('active', 'codexRssKiB', true),
      prompts: [...new Set(turns.map(turn => turn.promptIndex))].sort((a, b) => a - b).map(promptIndex => ({ promptIndex, ...aggregateTurns(turns.filter(turn => turn.promptIndex === promptIndex)) })),
    };
  });
}

export function formatBenchmarkMarkdown(rows: BenchmarkAggregate[]): string {
  const stats = (value: Statistics | null, scale = 1) => value ? `${(value.median / scale).toFixed(1)} [${(value.min / scale).toFixed(1)}–${(value.max / scale).toFixed(1)}]; n=${value.count}` : 'unknown';
  const lines = ['Benchmarks: median [min–max]; n is the number of runs or turns contributing to that metric.', '', '| Scenario | Harness | Runs / turns / RSS samples | First text ms | Turn ms | Loaded idle tree MiB | Active peak tree MiB | Failures |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.scenario} | ${row.harness} | ${row.runCount} / ${row.turnCount} / ${row.memorySampleCount} | ${stats(row.firstTextMs)} | ${stats(row.totalMs)} | ${stats(row.idleTreeRssKiB, 1024)} | ${stats(row.activePeakTreeRssKiB, 1024)} | ${row.failureCount} |`);
  lines.push('', '| Scenario | Harness | Startup ms | Active batch ms | Idle worker / Codex child MiB | Active peak worker / Codex child MiB | Input / output tokens | Cache ratio (known / unknown turns) |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) lines.push(`| ${row.scenario} | ${row.harness} | ${stats(row.startupMs)} | ${stats(row.runMs)} | ${stats(row.idleWorkerRssKiB, 1024)} / ${stats(row.idleCodexRssKiB, 1024)} | ${stats(row.activePeakWorkerRssKiB, 1024)} / ${stats(row.activePeakCodexRssKiB, 1024)} | ${row.inputTokens} / ${row.outputTokens} | ${row.cache.ratio === null ? 'unknown' : (row.cache.ratio * 100).toFixed(1) + '%'} (${row.cache.knownTurns} / ${row.cache.unknownTurns}) |`);
  lines.push('', '| Scenario | Harness | Prompt | First text ms | Turn ms | Input / output tokens | Known cached / uncached input | Cache ratio (known / unknown turns) |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) for (const prompt of row.prompts) lines.push(`| ${row.scenario} | ${row.harness} | ${['initial sentinel', 'follow-up sentinel', 'file task'][prompt.promptIndex] ?? prompt.promptIndex} | ${stats(prompt.firstTextMs)} | ${stats(prompt.totalMs)} | ${prompt.inputTokens} / ${prompt.outputTokens} | ${prompt.cache.cachedInputTokens} / ${prompt.cache.knownUncachedInputTokens} | ${prompt.cache.ratio === null ? 'unknown' : (prompt.cache.ratio * 100).toFixed(1) + '%'} (${prompt.cache.knownTurns} / ${prompt.cache.unknownTurns}) |`);
  lines.push('', 'RSS is a sum of resident pages, not unique physical memory; shared pages may be counted twice. Worker includes Node transport overhead and the tsx loader when that execution mode is used. Codex child RSS is separate; tree includes every live descendant. Idle values are medians per run; active peaks are sampled every 500ms and can miss short peaks.', '', 'Fresh histories/runtime roots reuse authorized auth and provider caches. Repetitions alternate harness order; counts above show observations for each scenario. Different native prompts, tool inventories, memory behavior and cache policies limit causal latency/cost comparisons. Unknown cache/reasoning usage is not zero; token totals are native reported main-turn usage, not an account billing audit.');
  return lines.join('\n') + '\n';
}
