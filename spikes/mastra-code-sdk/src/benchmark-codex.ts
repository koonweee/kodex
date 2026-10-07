import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BenchmarkRequest, BenchmarkStage, BenchmarkTurn } from './benchmark-summary.js';

// Wire shapes verified against checked-in app-server 0.160.0 JSON schemas.
// This private benchmark client is not a production gateway/API contract.
type RpcNotification = { method: string; params: Record<string, any> };
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number };

export async function createCodexBenchmarkRuntime(request: BenchmarkRequest & { binary: string; home: string }, options: { onStage?: (stage: BenchmarkStage) => void } = {}) {
  await mkdir(request.runtimeRoot, { recursive: true, mode: 0o700 });
  const child = spawn(request.binary, [
    'app-server', '--listen', 'stdio://',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'mcp_oauth_credentials_store="file"',
    '-c', `sqlite_home=${JSON.stringify(join(request.runtimeRoot, 'sqlite'))}`,
    '-c', `log_dir=${JSON.stringify(join(request.runtimeRoot, 'log'))}`,
    '-c', 'mcp_servers={}',
  ], { cwd: request.projectPaths[0], env: { ...process.env, CODEX_HOME: request.home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  let exited = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const listeners = new Set<(event: RpcNotification) => void>();
  // Never echo native stderr: provider errors can contain request/account details.
  child.stderr.resume();
  const exit = new Promise<void>(resolve => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('exit', () => {
      exited = true;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Benchmark app-server exited')); }
      pending.clear();
      resolve();
    });
  });
  child.on('error', () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Cannot start benchmark app-server')); }
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let data: Record<string, any>;
    try { data = JSON.parse(line); } catch { return; }
    if (typeof data.id === 'number' && pending.has(data.id)) {
      const call = pending.get(data.id)!;
      pending.delete(data.id); clearTimeout(call.timer);
      if (data.error) call.reject(new Error(`App-server benchmark RPC failed (${typeof data.error.code === 'number' ? data.error.code : 'unknown'})`));
      else call.resolve(data.result);
    } else if (data.id !== undefined && data.method) {
      child.stdin.write(JSON.stringify({ id: data.id, error: { code: -32601, message: 'Benchmark does not support interactive requests' } }) + '\n');
    } else if (typeof data.method === 'string') {
      for (const listener of listeners) listener({ method: data.method, params: data.params ?? {} });
    }
  });
  function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (exited) return Promise.reject(new Error('App-server has exited'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Benchmark RPC timed out: ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  let disposing: Promise<void> | undefined;
  function dispose(): Promise<void> {
    if (disposing) return disposing;
    disposing = (async () => {
      child.stdin.end();
      const killer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5_000);
      try { await exit; } finally { clearTimeout(killer); lines.close(); }
    })();
    return disposing;
  }
  const chats: Array<{ projectIndex: number; chatIndex: number; threadId: string }> = [];
  const usageByThread = new Map<string, Usage>();
  listeners.add(event => {
    if (event.method === 'thread/tokenUsage/updated' && event.params.tokenUsage?.total) usageByThread.set(event.params.threadId, event.params.tokenUsage.total);
  });
  try {
    await call('initialize', { clientInfo: { name: 'kodex_gateway', title: 'Kodex compatibility benchmark', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const account = await call('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('Benchmark requires dedicated ChatGPT login');
    for (const [projectIndex, cwd] of request.projectPaths.entries()) {
      for (let chatIndex = 0; chatIndex < request.chatsPerProject; chatIndex++) {
        const started = await call('thread/start', { cwd, model: request.model, allowProviderModelFallback: false, approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: request.effort }, serviceTier: 'default' });
        if (started.model !== request.model) throw new Error('App-server selected a different benchmark model');
        const threadId = started.thread?.id;
        if (typeof threadId !== 'string') throw new Error('Missing benchmark thread');
        await call('thread/name/set', { threadId, name: `Benchmark ${projectIndex}/${chatIndex}` });
        chats.push({ projectIndex, chatIndex, threadId });
      }
    }
  } catch (error) { await dispose(); throw error; }
  options.onStage?.({ type: 'loaded', loadedChats: chats.length });

  async function turn(chat: typeof chats[number], content: string, promptIndex: number): Promise<BenchmarkTurn> {
    const before = usageByThread.get(chat.threadId) ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
    const began = performance.now();
    let firstTextMs: number | null = null;
    let toolCalls = 0;
    let errors = false;
    let completed = false;
    let endTime = began;
    let usageSeen = false;
    let turnId: string | undefined;
    const answers = new Map<string, string>();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const ended = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    // Attach a handler immediately; an RPC rejection must not leave an unhandled timeout.
    void ended.catch(() => undefined);
    const timer = setTimeout(() => { fail(new Error('App-server benchmark turn timed out')); }, 120_000);
    const listener = ({ method, params }: RpcNotification) => {
      if (params.threadId !== chat.threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
      if (method === 'thread/tokenUsage/updated') usageSeen = true;
      if (method === 'item/agentMessage/delta' && params.delta) {
        firstTextMs ??= performance.now() - began;
        answers.set(params.itemId, (answers.get(params.itemId) ?? '') + params.delta);
      }
      if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(params.item?.type)) toolCalls++;
      if (method === 'item/completed' && params.item?.type === 'agentMessage') answers.set(params.item.id, params.item.text ?? '');
      if (method === 'error') errors = true;
      if (method === 'turn/completed') {
        completed = params.turn?.status === 'completed';
        errors ||= Boolean(params.turn?.error);
        endTime = performance.now(); finish();
      }
    };
    listeners.add(listener);
    options.onStage?.({ type: 'turnStart', projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex });
    try {
      const started = await call('turn/start', { threadId: chat.threadId, model: request.model, effort: request.effort, serviceTierForTurn: 'default', input: [{ type: 'text', text: content, text_elements: [] }] });
      turnId = started.turn?.id;
      await ended;
      const after = usageByThread.get(chat.threadId);
      if (!usageSeen || !after) throw new Error('Native app-server usage missing; refusing a zero-token result');
      const report: BenchmarkTurn = {
        projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex,
        firstTextMs, totalMs: endTime - began,
        inputTokens: after.inputTokens - before.inputTokens,
        outputTokens: after.outputTokens - before.outputTokens,
        cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
        reasoningTokens: after.reasoningOutputTokens - before.reasoningOutputTokens,
        toolCalls, answer: [...answers.values()].at(-1) ?? '', completed, errors,
      };
      options.onStage?.({ type: 'turnEnd', projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex, report });
      return report;
    } finally { clearTimeout(timer); listeners.delete(listener); }
  }
  return {
    loadedChats: chats.length,
    async run(prompts = request.prompts, activeChats = request.activeChats) {
      const reports = await Promise.all(chats.slice(0, activeChats).map(async chat => {
        const rows: BenchmarkTurn[] = [];
        for (const [promptIndex, prompt] of prompts.entries()) rows.push(await turn(chat, prompt, promptIndex));
        return rows;
      }));
      return { turns: reports.flat() };
    },
    dispose,
  };
}
