#!/usr/bin/env node

const baseUrl = process.env.KODEX_BASE_URL ?? "http://127.0.0.1:8787";
const prompt = process.env.KODEX_PROMPT;
const timeoutMs = Number(process.env.KODEX_TIMEOUT_MS ?? (prompt ? 300000 : 30000));
const stopOnIdle = process.env.KODEX_STOP_ON_IDLE !== "0";
const verboseKinds = new Set(
  (process.env.KODEX_EVENT_KINDS ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean),
);
const logAllEvents = process.env.KODEX_LOG_ALL_EVENTS === "1";

const runStartedAt = Date.now();
const stats = {
  baseUrl,
  threadId: process.env.KODEX_THREAD_ID ?? null,
  projectId: process.env.KODEX_PROJECT_ID ?? null,
  createdThread: false,
  submittedInput: false,
  submitAtMs: null,
  firstEventAtMs: null,
  firstPatchAtMs: null,
  firstDeltaAtMs: null,
  firstTerminalPatchAtMs: null,
  lastSeq: 0,
  eventCounts: new Map(),
  deltaEvents: 0,
  deltaChars: 0,
  patches: 0,
  refreshRequired: 0,
  terminalPatch: null,
};

function elapsed(ms = Date.now()) {
  return Number(((ms - runStartedAt) / 1000).toFixed(3));
}

function log(label, data = undefined) {
  const prefix = `[+${elapsed().toFixed(3)}s] ${label}`;
  if (data === undefined) {
    console.log(prefix);
  } else {
    console.log(`${prefix} ${JSON.stringify(data)}`);
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed ${response.status}: ${text}`);
  }
  return body;
}

async function resolveProjectId() {
  if (stats.projectId) {
    return stats.projectId;
  }
  const projectName = process.env.KODEX_PROJECT_NAME;
  if (!projectName) {
    return null;
  }
  const projects = await requestJson("/v1/projects");
  const project = projects.projects?.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`project not found: ${projectName}`);
  }
  stats.projectId = project.id;
  return project.id;
}

async function ensureThread() {
  if (stats.threadId) {
    return stats.threadId;
  }
  if (process.env.KODEX_CREATE_THREAD !== "1") {
    throw new Error("set KODEX_THREAD_ID, or set KODEX_CREATE_THREAD=1 with KODEX_PROJECT_ID/KODEX_PROJECT_NAME");
  }
  const projectId = await resolveProjectId();
  if (!projectId) {
    throw new Error("KODEX_CREATE_THREAD=1 requires KODEX_PROJECT_ID or KODEX_PROJECT_NAME");
  }
  const created = await requestJson("/v1/threads", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
  stats.threadId = created.thread.id;
  stats.createdThread = true;
  log("created thread", { threadId: stats.threadId, projectId });
  return stats.threadId;
}

function startSse(threadId, stop) {
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch(`${baseUrl}/v1/events?threadId=${encodeURIComponent(threadId)}`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE failed ${response.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseBlock(block, stop);
        boundary = buffer.indexOf("\n\n");
      }
    }
  })();
  return { controller, done };
}

function handleSseBlock(block, stop) {
  const eventName = block
    .split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) {
    return;
  }
  const event = JSON.parse(data);
  const now = Date.now();
  stats.firstEventAtMs ??= now;
  stats.lastSeq = Math.max(stats.lastSeq, event.seq ?? 0);
  stats.eventCounts.set(event.kind, (stats.eventCounts.get(event.kind) ?? 0) + 1);

  const summary = summarizeEvent(event, eventName);
  if (logAllEvents || verboseKinds.has(event.kind)) {
    log("event", summary);
  }

  if (event.kind === "thread_view.item_delta") {
    stats.firstDeltaAtMs ??= now;
    stats.deltaEvents += 1;
    const delta = typeof event.payload?.delta === "string" ? event.payload.delta : "";
    stats.deltaChars += delta.length;
    if (!logAllEvents && !verboseKinds.has(event.kind) && (stats.deltaEvents === 1 || stats.deltaEvents % 20 === 0)) {
      log("delta progress", { deltaEvents: stats.deltaEvents, deltaChars: stats.deltaChars, seq: event.seq });
    }
    return;
  }

  if (event.kind === "thread_view.refresh_required") {
    stats.refreshRequired += 1;
    if (!logAllEvents && !verboseKinds.has(event.kind)) {
      log("refresh_required", summary);
    }
    return;
  }

  if (event.kind === "thread_view.patch") {
    stats.firstPatchAtMs ??= now;
    stats.patches += 1;
    const liveState = event.payload?.liveState;
    if (!logAllEvents && !verboseKinds.has(event.kind)) {
      log("patch", summary);
    }
    if (stopOnIdle && liveState === "idle" && (!prompt || stats.submitAtMs !== null)) {
      stats.firstTerminalPatchAtMs ??= now;
      stats.terminalPatch = summary;
      stop();
    }
  }
}

function summarizeEvent(event, eventName) {
  const payload = event.payload ?? {};
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  const activeTurn =
    turns.find((turn) => turn.id === payload.activeTurnId) ??
    turns.find((turn) => turn.status === "inProgress" || turn.status === "running") ??
    turns.at(-1);
  return {
    eventName,
    seq: event.seq,
    kind: event.kind,
    codexMethod: event.codexMethod,
    threadId: event.threadId ?? payload.threadId,
    turnId: event.turnId ?? payload.turnId ?? activeTurn?.id,
    itemId: event.itemId ?? payload.itemId,
    liveState: payload.liveState,
    activeTurnId: payload.activeTurnId,
    itemCount: Array.isArray(payload.items) ? payload.items.length : undefined,
    turnCount: turns.length || undefined,
    turnStatus: activeTurn?.status,
    startedAt: activeTurn?.startedAt,
    completedAt: activeTurn?.completedAt,
    deltaChars: typeof payload.delta === "string" ? payload.delta.length : undefined,
    reason: payload.reason,
  };
}

async function submitPrompt(threadId) {
  if (!prompt) {
    return;
  }
  stats.submitAtMs = Date.now();
  const response = await requestJson(`/v1/threads/${encodeURIComponent(threadId)}/input`, {
    method: "POST",
    body: JSON.stringify({ input: [{ type: "text", text: prompt }] }),
  });
  stats.submittedInput = true;
  log("submitted input", { disposition: response.disposition });
}

function relativeToSubmit(ms) {
  return stats.submitAtMs && ms ? ms - stats.submitAtMs : null;
}

async function main() {
  const threadId = await ensureThread();
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const sse = startSse(threadId, resolveStop);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await submitPrompt(threadId);
  const timer = setTimeout(() => {
    log("timeout");
    resolveStop();
  }, timeoutMs);
  await stopped;
  clearTimeout(timer);
  sse.controller.abort();
  await sse.done.catch((error) => {
    if (error.name !== "AbortError") {
      throw error;
    }
  });

  const detail = await requestJson(`/v1/threads/${encodeURIComponent(threadId)}`);
  const finalTurn = Array.isArray(detail.timeline?.turns) ? detail.timeline.turns.at(-1) : null;
  const summary = {
    baseUrl,
    threadId,
    createdThread: stats.createdThread,
    submittedInput: stats.submittedInput,
    finalLiveState: detail.timeline?.liveState,
    finalActiveTurnId: detail.timeline?.activeTurnId,
    finalTurn,
    timingMs: {
      firstEvent: relativeToSubmit(stats.firstEventAtMs),
      firstPatch: relativeToSubmit(stats.firstPatchAtMs),
      firstDelta: relativeToSubmit(stats.firstDeltaAtMs),
      firstTerminalPatch: relativeToSubmit(stats.firstTerminalPatchAtMs),
    },
    eventCounts: Object.fromEntries([...stats.eventCounts.entries()].sort()),
    deltaEvents: stats.deltaEvents,
    deltaChars: stats.deltaChars,
    patches: stats.patches,
    refreshRequired: stats.refreshRequired,
    lastSeq: stats.lastSeq,
    terminalPatch: stats.terminalPatch,
  };
  log("summary", summary);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
