import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { activateProfile, resolveProfile } from './profile.js';
import { requireChatGptAuth } from './auth.js';
import { createProjectRuntime } from './runtime.js';
import { summarizeRequest, compareRequestPrefixes } from './cache-inspection.js';
import { readCacheResult, type WireResult } from './cache-response.js';

// Diagnostic-only wire observation in this disposable CLI process. No raw bodies,
// model text, account/header values or credentials are persisted or printed.
type Body = Record<string, any>;

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const mode = process.argv[3] ?? 'screen';
if (!['screen', 'affinity', 'native-affinity'].includes(mode)) throw new Error('Unknown experiment');
let nativeCondition = 'stock';
let affinityKey = randomUUID();
const prompt = 'Do not use tools. Reply with exactly CACHE_PROBE_OK and nothing else.';
const profile = activateProfile(resolveProfile());
const authStorage = requireChatGptAuth(profile);
const root = await mkdtemp(join(tmpdir(), 'kodex-cache-evaluation-'));
const output = resolve(process.argv[2] ?? `artifacts/cache-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) { await rm(root, { recursive: true, force: true }); throw new Error('Use a fresh output directory'); }
const nativeFetch = globalThis.fetch;
const progress = console.error.bind(console);
const print = console.log.bind(console);
// Native error objects may contain provider request details; emit only our summaries.
console.error = () => {}; console.warn = () => {}; console.log = () => {}; console.info = () => {}; console.debug = () => {};
const captured: Array<{ body: Body; condition: string; summary: ReturnType<typeof summarizeRequest>; headersPresent: Record<string, boolean>; result?: WireResult }> = [];
const pending: Promise<void>[] = [];
const report: { native: unknown[]; replay: unknown[]; errors: string[] } = { native: [], replay: [], errors: [] };
let runtime: Awaited<ReturnType<typeof createProjectRuntime>> | undefined;
function valid(result: WireResult | undefined): boolean {
  return Boolean(result?.completed && result.correct && result.input !== null && result.input > 0 && result.output !== null && result.output >= 0 && result.cached !== null && result.cached >= 0 && result.cached <= result.input);
}
const save = async () => {
  report.native = captured.map((item, index) => ({ index, condition: item.condition, request: item.summary, headersPresent: item.headersPresent, result: item.result, ...(index > 0 ? { comparedWithPrevious: compareRequestPrefixes(captured[index - 1]!.body, item.body) } : {}) }));
  await writeFile(join(output, 'report.json'), JSON.stringify({ mode, model: 'gpt-6.1-sol', effort: 'low', sdk: '1.10.1', generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n', { mode: 0o600 });
};
try {
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint) return nativeFetch(input, init);
    if (nativeCondition === 'header-on') request.headers.set('session-id', affinityKey);
    if (nativeCondition === 'header-off') request.headers.delete('session-id');
    const body = JSON.parse(await request.clone().text()) as Body;
    const row: typeof captured[number] = { body, condition: nativeCondition, summary: summarizeRequest(body), headersPresent: Object.fromEntries(['session-id', 'session_id', 'x-session-id', 'x-codex-turn-metadata', 'x-codex-turn-state', 'originator'].map(name => [name, request.headers.has(name)])) };
    captured.push(row); const started = performance.now();
    const response = await nativeFetch(request);
    pending.push(readCacheResult(response.clone(), started).then(result => { row.result = result; }).catch(() => { report.errors.push('Native response inspection failed'); }));
    return response;
  }) as typeof fetch;
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), modes: [{ id: 'build', defaultModelId: 'openai/gpt-6.1-sol', metadata: { default: true } }] });
  const groups = mode === 'native-affinity' ? ['header-off', 'header-on', 'header-on', 'header-off'] : ['stock'];
  for (const [groupIndex, group] of groups.entries()) {
    nativeCondition = group; affinityKey = randomUUID();
    const session = await runtime.createSession({ resourceId: randomUUID(), threadId: randomUUID() });
    await session.thread.rename({ title: 'Cache evaluation' }); await session.state.set({ thinkingLevel: 'low' });
    for (let i = 0; i < (mode === 'affinity' ? 1 : 4); i++) {
      progress(`Native ${groupIndex + 1}/${groups.length} ${group} probe ${i + 1}`);
      const timer = setTimeout(() => session.abort(), 90_000);
      const before = captured.length;
      try { await session.sendMessage({ content: prompt }); } finally { clearTimeout(timer); }
      await Promise.all(pending); await save();
      if (captured.length !== before + 1 || !valid(captured.at(-1)?.result)) throw new Error('Native probe failed');
    }
  }
  globalThis.fetch = nativeFetch;
  const { buildOpenAICodexOAuthFetch } = await import('@mastra/code-sdk/providers/openai-codex');
  const oauthFetch = buildOpenAICodexOAuthFetch({ authStorage });
  const base = captured.at(-1)!.body;
  const key = randomUUID();
  const variants = mode === 'screen' ? ['identical', 'key', 'key-session', 'implicit', 'breakpoint'] : mode === 'affinity' ? ['key', 'key-session', 'key-session', 'key', 'key-session', 'key', 'key', 'key-session', 'key-session', 'key', 'key-session', 'key'] : [];
  for (const [order, variant] of variants.entries()) {
    for (let repeat = 0; repeat < (mode === 'screen' ? 3 : 1); repeat++) {
      const body: Body = structuredClone(base);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (variant === 'key' || variant === 'key-session') body.prompt_cache_key = key;
      if (variant === 'key-session') headers['session-id'] = key;
      if (variant === 'implicit') body.prompt_cache_options = { mode: 'implicit' };
      if (variant === 'breakpoint') {
        const developer = body.input?.find((item: Body) => item.role === 'developer' || item.role === 'system');
        if (!developer) { report.errors.push('No developer block available for breakpoint experiment'); break; }
        if (typeof developer.content === 'string') developer.content = [{ type: 'input_text', text: developer.content }];
        const text = developer.content?.findLast((item: Body) => item.type === 'input_text');
        if (!text) { report.errors.push('No developer text block available for breakpoint experiment'); break; }
        text.prompt_cache_breakpoint = { mode: 'explicit' };
      }
      progress(`Replay ${variant}, sequence ${order + 1}, repeat ${repeat + 1}`);
      const started = performance.now();
      const response = await oauthFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const result = await readCacheResult(response, started);
      report.replay.push({ order, variant, repeat, request: summarizeRequest(body), result }); await save();
      if (result.status === 400 && (variant === 'implicit' || variant === 'breakpoint')) break;
      if (!valid(result)) throw new Error('Replay failed correctness or usage validation');
    }
  }
} catch { report.errors.push('Evaluation failed; raw upstream diagnostics suppressed'); process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch; await Promise.allSettled(pending); await runtime?.dispose(); await rm(root, { recursive: true, force: true }); await save(); }
print(JSON.stringify({ output, native: captured.map(row => row.result), replay: report.replay.map((row: any) => ({ variant: row.variant, repeat: row.repeat, result: row.result })), errors: report.errors }));
