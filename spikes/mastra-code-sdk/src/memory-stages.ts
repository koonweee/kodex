import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectRuntime } from './runtime.js';

type Scenario = 'single-project' | 'three-projects';
type MemorySample = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers'>;
interface Stage {
  name: string;
  projects: number;
  chats: number;
  beforeGc: { samples: MemorySample[]; medianBytes: MemorySample };
  diagnosticAfterGc?: { samples: MemorySample[]; medianBytes: MemorySample };
}
const sampleCount = 5;
const sampleIntervalMs = 200;
const fields = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'] as const;

function options() {
  let scenario: Scenario = 'single-project';
  let output: string | undefined;
  const args = process.argv.slice(2);
  while (args.length) {
    const argument = args.shift();
    const value = args.shift();
    if (argument === '--scenario' && (value === 'single-project' || value === 'three-projects')) scenario = value;
    else if (argument === '--output' && value) output = resolve(value);
    else throw new Error('Usage: memory-stages --scenario single-project|three-projects --output <new-json-file>');
  }
  if (!output) throw new Error('A new --output JSON path is required.');
  return { scenario, output };
}

async function sampleMemory() {
  const samples: MemorySample[] = [];
  for (let index = 0; index < sampleCount; index++) {
    await delay(sampleIntervalMs);
    samples.push(process.memoryUsage());
  }
  const medianBytes = Object.fromEntries(fields.map(field => [field, samples.map(sample => sample[field]).sort((a, b) => a - b)[Math.floor(sampleCount / 2)]!])) as MemorySample;
  return { samples, medianBytes };
}

async function main() {
  const { scenario, output } = options();
  const stages: Stage[] = [];
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc : undefined;
  const measure = async (name: string, projects: number, chats: number) => {
    const stage: Stage = { name, projects, chats, beforeGc: await sampleMemory() };
    if (gc) {
      gc();
      stage.diagnosticAfterGc = await sampleMemory();
    }
    stages.push(stage);
  };
  // Only Node built-ins and erased types are imported before this baseline.
  // Loading the full SDK is intentional attribution, not a proposed host import.
  await measure('baseline', 0, 0);
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-memory-stages-'));
  const runtimes: ProjectRuntime[] = [];
  try {
    const { activateProfile, resolveProfile } = await import('./profile.js');
    const profile = activateProfile(resolveProfile(join(root, 'profile')));
    // A disposable empty credential profile and unreachable loopback provider
    // keep model selection local. This diagnostic never calls sendMessage().
    await writeFile(profile.settingsPath, JSON.stringify({
      lsp: false,
      observability: { enabled: false },
      customProviders: [{ name: 'measurement', url: 'http://127.0.0.1:9/v1', apiKey: 'measurement-no-credential', models: ['never-call'] }],
      models: { observerModelOverride: 'measurement/never-call', reflectorModelOverride: 'measurement/never-call', goalJudgeModel: 'measurement/never-call' },
    }));
    await import('@mastra/code-sdk');
    await measure('full-sdk-imported', 0, 0);
    const { createProjectRuntime } = await import('./runtime.js');
    const mount = async (projectIndex: number) => {
      const projectPath = join(root, `project-${projectIndex}`);
      await mkdir(projectPath);
      const runtime = await createProjectRuntime({
        projectPath, runtimeRoot: join(root, `runtime-${projectIndex}`), profile,
        modes: [{ id: 'build', defaultModelId: 'measurement/never-call', metadata: { default: true } }],
      });
      runtimes.push(runtime);
      return runtime;
    };
    let chats = 0;
    const addChat = async (runtime: ProjectRuntime, projectIndex: number, chatIndex: number) => {
      const resourceId = `measurement-project-${projectIndex}-chat-${chatIndex}`;
      const threadId = `measurement-thread-${projectIndex}-${chatIndex}`;
      const session = await runtime.createSession({ resourceId, threadId });
      if (session.identity.getResourceId() !== resourceId || session.thread.getId() !== threadId) throw new Error('Native session identity mismatch');
      chats++;
    };
    if (scenario === 'single-project') {
      const runtime = await mount(0);
      await measure('one-project-zero-chats', 1, 0);
      for (const target of [1, 5, 15]) {
        while (chats < target) await addChat(runtime, 0, chats);
        await measure(`one-project-${target}-chats`, 1, chats);
      }
    } else {
      for (let projectIndex = 0; projectIndex < 3; projectIndex++) await mount(projectIndex);
      await measure('three-projects-zero-chats', 3, 0);
      for (let projectIndex = 0; projectIndex < 3; projectIndex++) {
        for (let chatIndex = 0; chatIndex < 5; chatIndex++) await addChat(runtimes[projectIndex]!, projectIndex, chatIndex);
      }
      await measure('three-projects-five-chats-each', 3, chats);
    }
    const report = {
      version: 1,
      scenario,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      launchMode: process.execArgv.some(argument => argument.includes('tsx')) ? 'tsx' : 'plain-node',
      sampleCount,
      sampleIntervalMs,
      units: 'bytes',
      diagnosticGcEnabled: Boolean(gc),
      limitations: [
        'Current-process memory only; RSS includes resident native allocations and mapped pages, not just the V8 heap.',
        'Bounded idle samples are not a guarantee of quiescence; repeat fresh processes to assess variance.',
        'Full SDK import is retained in the module cache and may differ from normal host import paths.',
        'Chat sessions are empty: this measures mounting and loaded-session overhead, not active turns or retained conversation content.',
        ...(gc ? ['Explicit GC is diagnostic, not normal performance; later beforeGc stages also follow earlier forced collections.'] : []),
      ],
      stages,
    };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    try {
      for (const runtime of runtimes.reverse()) await runtime.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

await main();
