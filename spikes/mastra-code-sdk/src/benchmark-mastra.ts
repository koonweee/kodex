import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { activateProfile, resolveProfile } from './profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from './runtime.js';

import type { BenchmarkRequest, BenchmarkStage, BenchmarkTurn } from './benchmark-summary.js';

export type MastraBenchmarkRequest = BenchmarkRequest;
export type MastraTurnReport = BenchmarkTurn;
export type MastraBenchmarkStage = BenchmarkStage;
export interface MastraBenchmarkOptions {
  onStage?: (stage: MastraBenchmarkStage) => void | Promise<void>;
}
type LoadedChat = { projectIndex: number; chatIndex: number; session: NativeSession };

/** Mounted idle chats remain alive for the driver's RSS sampling before run(). */
export async function createMastraBenchmarkRuntime(request: MastraBenchmarkRequest, options: MastraBenchmarkOptions = {}) {
  if (!request.projectPaths.length || !Number.isSafeInteger(request.chatsPerProject) || request.chatsPerProject < 1) throw new Error('Benchmark requires projects and a positive chatsPerProject');
  if (request.effort !== 'low' || !request.model.trim()) throw new Error('Benchmark requires a model and low effort');
  const profile = activateProfile(resolveProfile(request.profileRoot));
  const runtimes: ProjectRuntime[] = [];
  const chats: LoadedChat[] = [];
  const id = randomUUID();
  let disposed = false;
  let running = false;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    if (!disposal) {
      disposed = true;
      disposal = (async () => {
        const results = await Promise.allSettled(runtimes.map(runtime => runtime.dispose()));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })();
    }
    return disposal;
  };
  try {
    // Keep native memory and tool inventory. Profile settings govern observer/judge
    // models; this helper never rewrites those shared settings or credentials.
    for (const [projectIndex, projectPath] of request.projectPaths.entries()) {
      const runtime = await createProjectRuntime({
        projectPath,
        runtimeRoot: path.join(request.runtimeRoot, `project-${projectIndex}`),
        profile,
        modes: [{ id: 'build', defaultModelId: request.model, metadata: { default: true } }],
      });
      runtimes.push(runtime);
      for (let chatIndex = 0; chatIndex < request.chatsPerProject; chatIndex++) {
        const session = await runtime.createSession({ resourceId: `benchmark-${id}-project-${projectIndex}-chat-${chatIndex}`, threadId: `benchmark-${id}-project-${projectIndex}-chat-${chatIndex}` });
        await session.thread.rename({ title: `Benchmark project ${projectIndex} chat ${chatIndex}` });
        await session.state.set({ thinkingLevel: request.effort });
        await session.model.saveForMode({ modeId: 'build', modelId: request.model });
        if (session.state.get().projectPath !== path.resolve(projectPath) || runtime.projectPath !== path.resolve(projectPath)) throw new Error('Native benchmark session resolved a different project root');
        if (session.state.get().thinkingLevel !== request.effort || session.model.get() !== request.model) throw new Error('Native benchmark model or effort selection was not applied');
        chats.push({ projectIndex, chatIndex, session });
      }
    }
    await options.onStage?.({ type: 'loaded', loadedChats: chats.length });
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    loadedChats: chats.length,
    async run(prompts = request.prompts, activeChats = request.activeChats): Promise<{ turns: MastraTurnReport[] }> {
      if (disposed || running) throw new Error('Benchmark runtime is disposed or already running');
      if (!Number.isSafeInteger(activeChats) || activeChats < 1 || activeChats > chats.length) throw new Error('activeChats must select between one and all loaded chats');
      running = true;
      try {
        const batches = await Promise.all(chats.slice(0, activeChats).map(async chat => {
          const turns: MastraTurnReport[] = [];
          for (const [promptIndex, prompt] of prompts.entries()) {
            await options.onStage?.({ type: 'turnStart', projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex });
            const turn = await measureTurn(chat, promptIndex, prompt);
            turns.push(turn);
            await options.onStage?.({ type: 'turnEnd', projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex, report: turn });
          }
          return turns;
        }));
        return { turns: batches.flat() };
      } finally {
        running = false;
      }
    },
    dispose,
  };
}

async function measureTurn(chat: LoadedChat, promptIndex: number, prompt: string): Promise<MastraTurnReport> {
  const { session } = chat;
  const before = { ...session.displayState.get().tokenUsage };
  const existing = new Set((await session.thread.listActiveMessages()).map(message => message.id));
  let firstTextMs: number | null = null;
  let toolCalls = 0;
  let errors = false;
  let completed = false;
  let usageSteps = 0;
  let mainUsageReported = true;
  let cachedReported = true;
  let reasoningReported = true;
  let answer = '';
  const started = performance.now();
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_update' && event.event.type === 'text-delta' && event.event.delta.length && firstTextMs === null) firstTextMs = performance.now() - started;
    if (event.type === 'tool_start') toolCalls++;
    if (event.type === 'error') errors = true;
    if (event.type === 'usage_update') {
      usageSteps++;
      mainUsageReported &&= event.usage.promptTokens + event.usage.completionTokens > 0;
      cachedReported &&= (event.usage.cachedInputTokens ?? 0) > 0;
      reasoningReported &&= (event.usage.reasoningTokens ?? 0) > 0;
    }
    if (event.type === 'agent_end') completed = event.reason === 'complete';
  });
  let totalMs: number;
  try {
    await session.sendMessage({ content: prompt });
    totalMs = performance.now() - started;
    const messages = await session.thread.listActiveMessages();
    // Native messages can hold pre-tool commentary and final text in separate
    // parts of one assistant row. Grade the last text part, matching the final answer.
    answer = messages.filter(message => message.role === 'assistant' && !existing.has(message.id)).flatMap(message => message.content.parts.filter(part => part.type === 'text').map(part => part.text)).filter(Boolean).at(-1) ?? '';
  } catch {
    totalMs = performance.now() - started;
    errors = true;
  } finally {
    unsubscribe();
  }
  const after = session.displayState.get().tokenUsage;
  const inputTokens = after.promptTokens - before.promptTokens;
  const outputTokens = after.completionTokens - before.completionTokens;
  // A missing model-step usage can become zero even when another step is measured.
  if (usageSteps === 0 || !mainUsageReported || inputTokens + outputTokens <= 0) errors = true;
  // Display counters accumulate all model steps for the thread, not just this turn.
  // The SDK normalizes omitted optional usage to zero. Preserve unknown when
  // any step has zero/missing coverage, including genuinely reported zeros that
  // cannot be distinguished here; positive values on every step are measurable.
  const optionalDelta = (key: 'cachedInputTokens' | 'reasoningTokens', reported: boolean) => usageSteps === 0 || !reported || after[key] === undefined ? null : after[key] - (before[key] ?? 0);
  return {
    projectIndex: chat.projectIndex, chatIndex: chat.chatIndex, promptIndex,
    firstTextMs, totalMs,
    inputTokens, outputTokens,
    cachedInputTokens: optionalDelta('cachedInputTokens', cachedReported),
    reasoningTokens: optionalDelta('reasoningTokens', reasoningReported),
    toolCalls, answer, completed: completed && !errors, errors,
  };
}

export async function runMastraBenchmark(request: MastraBenchmarkRequest, options: MastraBenchmarkOptions = {}) {
  const benchmark = await createMastraBenchmarkRuntime(request, options);
  try { return await benchmark.run(); }
  finally { await benchmark.dispose(); }
}
