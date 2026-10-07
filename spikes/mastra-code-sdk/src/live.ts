import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile } from './profile.js';
import { requireChatGptAuth } from './auth.js';
import { createProjectRuntime } from './runtime.js';

// Opt-in network smoke: actual ChatGPT login, disposable project/history, no file tools requested.
const profile = activateProfile(resolveProfile());
requireChatGptAuth(profile);
const model = process.env.KODEX_MASTRA_MODEL ?? 'openai/gpt-6.1-sol';
let settings: Record<string, unknown> = {};
try { settings = JSON.parse(await readFile(profile.settingsPath, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
// Use the signed-in provider for native memory/title/judge calls as well as chat.
await writeFile(profile.settingsPath, JSON.stringify({
  ...settings,
  models: { ...(settings.models as object), observerModelOverride: model, reflectorModelOverride: model, goalJudgeModel: model, goalMaxTurns: Number.MAX_SAFE_INTEGER },
  observability: { enabled: false },
}, null, 2) + '\n', { mode: 0o600 });
const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-live-'));
const projectPath = join(root, 'project');
await mkdir(projectPath);
let runtime: Awaited<ReturnType<typeof createProjectRuntime>> | undefined;
let timer: NodeJS.Timeout | undefined;
let stage = 'mount';
try {
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true, modes: [{ id: 'build', defaultModelId: model, metadata: { default: true } }] });
  stage = 'session';
  const session = await runtime.createSession({ resourceId: 'live-chat', threadId: 'live-thread' });
  await session.thread.rename({ title: 'Kodex live smoke' });
  let terminalReason: string | undefined;
  let hadError = false;
  let timedOut = false;
  session.subscribe(event => {
    if (event.type === 'agent_end') terminalReason = event.reason;
    if (event.type === 'error') {
      hadError = true;
      // Report only allowlisted diagnostics, never serialize provider errors.
      let cause: unknown = event.error;
      for (let depth = 0; cause && typeof cause === 'object' && depth < 5; depth++) {
        const item = cause as Record<string, unknown>;
        if (typeof item.statusCode === 'number') console.error(JSON.stringify({ providerHttpStatus: item.statusCode }));
        if (typeof item.responseBody === 'string' && item.responseBody.includes('not supported when using Codex with a ChatGPT account')) {
          console.error('Selected model is unavailable to this ChatGPT account; set KODEX_MASTRA_MODEL to an available model.');
        }
        cause = item.cause;
      }
    }
  });
  timer = setTimeout(() => { timedOut = true; session.abort(); }, 90_000);
  stage = 'send';
  await session.sendMessage({ content: 'Reply with exactly KODEX_MASTRA_OK. Do not use tools.' });
  stage = 'history';
  const messages = await session.thread.listActiveMessages();
  stage = 'assert-response';
  assert.equal(timedOut, false);
  assert.equal(hadError, false);
  assert.equal(terminalReason, 'complete');
  const answer = messages.findLast(message => message.role === 'assistant');
  const text = answer?.content.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  assert.equal(text?.trim(), 'KODEX_MASTRA_OK');
  assert.equal(session.displayState.get().isRunning, false);
  const { promptTokens, completionTokens, totalTokens } = session.displayState.get().tokenUsage;
  console.log(JSON.stringify({ passed: true, profile: profile.root, model, pid: process.pid, promptTokens, completionTokens, totalTokens }));
} catch {
  console.log(JSON.stringify({ failedStage: stage }));
  console.error('Live SDK smoke failed. Credentials and provider errors are not printed.');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await runtime?.dispose();
  await rm(root, { recursive: true, force: true });
}
