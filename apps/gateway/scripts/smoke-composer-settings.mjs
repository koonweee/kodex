#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const codexBinary = process.env.KODEX_CODEX_BINARY ?? "codex";
const cwd = process.env.KODEX_SMOKE_CWD ?? process.cwd();
const home = await mkdtemp(join(tmpdir(), "kodex-composer-smoke-"));
const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
  env: { ...process.env, HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`non-json app-server output: ${line}\n`);
    return;
  }

  if (message.id === undefined || !pending.has(message.id)) {
    return;
  }

  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) {
    reject(new Error(JSON.stringify(message.error)));
  } else {
    resolve(message.result);
  }
});

try {
  await request("initialize", {
    clientInfo: {
      name: "kodex_composer_settings_smoke",
      title: "Kodex Composer Settings Smoke",
      version: "0.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  notify("initialized");

  const before = await request("config/read", { cwd, includeLayers: false });
  await request("config/batchWrite", {
    edits: [
      { keyPath: "model", mergeStrategy: "replace", value: "gpt-5.4" },
      { keyPath: "model_reasoning_effort", mergeStrategy: "replace", value: "high" },
      { keyPath: "service_tier", mergeStrategy: "replace", value: "fast" },
    ],
  });
  const after = await request("config/read", { cwd, includeLayers: false });

  assertEqual(after.config?.model, "gpt-5.4", "config model");
  assertEqual(after.config?.model_reasoning_effort, "high", "config reasoning effort");
  assertEqual(after.config?.service_tier, "fast", "config service tier");

  const thread = await request("thread/start", {
    cwd,
    model: "gpt-5.4",
    serviceTier: "fast",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  });

  assertEqual(thread.model, "gpt-5.4", "thread model");
  assertEqual(thread.serviceTier, "fast", "thread service tier");
  assertEqual(thread.approvalPolicy, "never", "thread approval policy");
  assertEqual(thread.approvalsReviewer, "user", "thread approvals reviewer");
  assertEqual(thread.sandbox?.type, "dangerFullAccess", "thread sandbox");

  const turn = await request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "Smoke test composer settings." }],
    model: "gpt-5.4",
    effort: "high",
    serviceTier: "fast",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
  });

  assertEqual(turn.turn?.status, "inProgress", "turn status");

  console.log(
    JSON.stringify(
      {
        ok: true,
        configBefore: compactConfig(before.config),
        configAfter: compactConfig(after.config),
        thread: {
          model: thread.model,
          serviceTier: thread.serviceTier,
          approvalPolicy: thread.approvalPolicy,
          approvalsReviewer: thread.approvalsReviewer,
          sandbox: thread.sandbox,
        },
        turn: {
          id: turn.turn?.id,
          status: turn.turn?.status,
        },
      },
      null,
      2,
    ),
  );
} finally {
  child.kill("SIGTERM");
  await rm(home, { force: true, recursive: true });
}

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function compactConfig(config) {
  return {
    model: config?.model ?? null,
    effort: config?.model_reasoning_effort ?? null,
    serviceTier: config?.service_tier ?? null,
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
