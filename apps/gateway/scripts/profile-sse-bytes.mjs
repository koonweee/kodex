#!/usr/bin/env node
/*
Profile the selected-thread Kodex SSE stream for before/after bandwidth tests.

Prerequisite:
  Run a Kodex gateway locally, usually at http://127.0.0.1:8787.

Attach to an existing thread without submitting input:
  KODEX_THREAD_ID=<thread-id> \
    apps/gateway/scripts/profile-sse-bytes.mjs

Create a thread for a project and submit a deterministic stress prompt:
  KODEX_BASE_URL=http://127.0.0.1:8787 \
  KODEX_CREATE_THREAD=1 \
  KODEX_PROJECT_CWD=/Users/example/kodex \
  KODEX_PROMPT='Write a detailed 12000-word technical analysis of this repository architecture. Stream the answer naturally and include sectioned detail.' \
  KODEX_TIMEOUT_MS=300000 \
    apps/gateway/scripts/profile-sse-bytes.mjs > /tmp/kodex-sse-before.json

Useful environment variables:
  KODEX_BASE_URL                         Gateway URL. Default: http://127.0.0.1:8787
  KODEX_THREAD_ID                        Existing thread to observe.
  KODEX_CREATE_THREAD=1                  Create a new project thread before observing.
  KODEX_PROJECT_ID                       Project id for created threads.
  KODEX_PROJECT_NAME                     Project name to resolve through GET /v1/projects.
  KODEX_PROJECT_CWD                      Project cwd to resolve or create through /v1/projects.
  KODEX_PROMPT                           Prompt to submit after opening SSE.
  KODEX_TIMEOUT_MS                       Maximum observation time. Default: 300000 with a prompt, 60000 without.
  KODEX_STOP_ON_IDLE=0                   Keep observing after a terminal idle patch.
  KODEX_CURSOR=<seq>                     Explicit SSE cursor. By default the script uses the thread snapshot viewRevision.
  KODEX_SKIP_INITIAL_SNAPSHOT=1          Open SSE without first reading /v1/threads/{threadId}.
  KODEX_REPORT_INTERVAL_MS=5000          Progress log interval.
  KODEX_LOG_LARGE_EVENTS_OVER_BYTES      Log event summaries over this size. Default: 1000000.

Output:
  Progress logs are written to stderr. The final machine-readable JSON report is
  written to stdout so it can be redirected to /tmp/kodex-sse-before.json and
  /tmp/kodex-sse-after.json. Compare rawBytesPerMinute, byKind, patchScopes, and
  largestEvents to evaluate a fix.
*/

const baseUrl = process.env.KODEX_BASE_URL ?? "http://127.0.0.1:8787";
const prompt = process.env.KODEX_PROMPT ?? null;
const timeoutMs = Number(process.env.KODEX_TIMEOUT_MS ?? (prompt ? 300000 : 60000));
const reportIntervalMs = Number(process.env.KODEX_REPORT_INTERVAL_MS ?? 5000);
const stopOnIdle = process.env.KODEX_STOP_ON_IDLE !== "0";
const largeEventThreshold = Number(process.env.KODEX_LOG_LARGE_EVENTS_OVER_BYTES ?? 1000000);
const encoder = new TextEncoder();

const startedAt = Date.now();
const stats = {
  rawBytes: 0,
  eventBytes: 0,
  events: 0,
  lastSeq: 0,
  submittedAt: null,
  stoppedAt: null,
  threadId: process.env.KODEX_THREAD_ID ?? null,
  createdThread: false,
  byKind: new Map(),
  patchScopes: new Map(),
  largestEvents: [],
};

function elapsedMs(now = Date.now()) {
  return now - startedAt;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function bytesPerMinute(bytes, ms) {
  if (ms <= 0) {
    return 0;
  }
  return (bytes * 60000) / ms;
}

function log(label, data = undefined) {
  const prefix = `[+${(elapsedMs() / 1000).toFixed(3)}s] ${label}`;
  if (data === undefined) {
    console.error(prefix);
  } else {
    console.error(`${prefix} ${JSON.stringify(data)}`);
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
  if (process.env.KODEX_PROJECT_ID) {
    return process.env.KODEX_PROJECT_ID;
  }

  const projectName = process.env.KODEX_PROJECT_NAME;
  if (projectName) {
    const projects = await requestJson("/v1/projects");
    const project = projects.projects?.find((candidate) => candidate.name === projectName);
    if (!project) {
      throw new Error(`project not found: ${projectName}`);
    }
    return project.id;
  }

  const projectCwd = process.env.KODEX_PROJECT_CWD;
  if (projectCwd) {
    const projects = await requestJson("/v1/projects");
    const existing = projects.projects?.find((candidate) => candidate.cwd === projectCwd);
    if (existing) {
      return existing.id;
    }
    const project = await requestJson("/v1/projects", {
      method: "POST",
      body: JSON.stringify({ cwd: projectCwd, createDirectory: false }),
    });
    return project.id;
  }

  return null;
}

async function ensureThread() {
  if (stats.threadId) {
    return stats.threadId;
  }
  if (process.env.KODEX_CREATE_THREAD !== "1") {
    throw new Error(
      "set KODEX_THREAD_ID, or set KODEX_CREATE_THREAD=1 with KODEX_PROJECT_ID/KODEX_PROJECT_NAME/KODEX_PROJECT_CWD",
    );
  }
  const projectId = await resolveProjectId();
  if (!projectId) {
    throw new Error("KODEX_CREATE_THREAD=1 requires a project id, project name, or project cwd");
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

async function initialCursor(threadId) {
  if (process.env.KODEX_CURSOR !== undefined) {
    return Number(process.env.KODEX_CURSOR);
  }
  if (process.env.KODEX_SKIP_INITIAL_SNAPSHOT === "1") {
    return undefined;
  }
  const detail = await requestJson(`/v1/threads/${encodeURIComponent(threadId)}`);
  return detail.timeline?.viewRevision ?? 0;
}

function sseUrl(threadId, cursor) {
  const url = new URL("/v1/events", baseUrl);
  url.searchParams.set("threadId", threadId);
  if (Number.isFinite(cursor)) {
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

function startSse(threadId, cursor, stop) {
  const controller = new AbortController();
  const done = (async () => {
    const url = sseUrl(threadId, cursor);
    log("opening selected-thread SSE", {
      url: `${url.pathname}${url.search}`,
      threadId,
      cursor: Number.isFinite(cursor) ? cursor : null,
    });
    const response = await fetch(url, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE failed ${response.status}`);
    }

    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      stats.rawBytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.nextIndex);
        handleSseBlock(block, stop);
        boundary = findSseBoundary(buffer);
      }
    }
  })();
  return { controller, done };
}

function findSseBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, nextIndex: crlf + 4 };
  }
  return { index: lf, nextIndex: lf + 2 };
}

function handleSseBlock(block, stop) {
  const lines = block.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) {
    return;
  }

  const eventBytes = encoder.encode(`${block}\n\n`).byteLength;
  stats.eventBytes += eventBytes;
  stats.events += 1;

  let event;
  try {
    event = JSON.parse(data);
  } catch (error) {
    recordKind("parse_error", eventBytes, null);
    throw error;
  }

  const kind = event.kind ?? "unknown";
  const payload = event.payload ?? {};
  stats.lastSeq = Math.max(stats.lastSeq, event.seq ?? 0);
  recordKind(kind, eventBytes, event);

  if (kind === "thread_view.patch") {
    const scope = payload.scope ?? "unknown";
    stats.patchScopes.set(scope, (stats.patchScopes.get(scope) ?? 0) + 1);
    if (stopOnIdle && payload.liveState === "idle" && (!prompt || stats.submittedAt !== null)) {
      stats.stoppedAt = Date.now();
      stop();
    }
  }

  if (eventBytes >= largeEventThreshold) {
    log("large event", eventSummary(event, eventBytes));
  }
}

function recordKind(kind, eventBytes, event) {
  const current = stats.byKind.get(kind) ?? {
    count: 0,
    bytes: 0,
    maxBytes: 0,
    patchRows: 0,
    patchRowCountSamples: 0,
    maxPatchRows: 0,
  };
  current.count += 1;
  current.bytes += eventBytes;
  current.maxBytes = Math.max(current.maxBytes, eventBytes);

  const rows = event?.payload && Array.isArray(event.payload.rows) ? event.payload.rows.length : null;
  if (rows !== null) {
    current.patchRows += rows;
    current.patchRowCountSamples += 1;
    current.maxPatchRows = Math.max(current.maxPatchRows, rows);
  }
  stats.byKind.set(kind, current);

  if (event) {
    stats.largestEvents.push(eventSummary(event, eventBytes));
    stats.largestEvents.sort((left, right) => right.bytes - left.bytes);
    stats.largestEvents.length = Math.min(stats.largestEvents.length, 10);
  }
}

function eventSummary(event, bytes) {
  const payload = event.payload ?? {};
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  const rowKinds = rows
    ? Object.entries(
        rows.reduce((acc, row) => {
          const kind = row.kind ?? "unknown";
          acc[kind] = (acc[kind] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort()
    : undefined;
  return {
    bytes,
    seq: event.seq,
    kind: event.kind,
    codexMethod: event.codexMethod,
    scope: payload.scope,
    liveState: payload.liveState,
    activeTurnId: payload.activeTurnId,
    turnId: event.turnId ?? payload.turnId,
    itemId: event.itemId ?? payload.itemId,
    rows: rows?.length,
    rowKinds,
    turns: Array.isArray(payload.turns) ? payload.turns.length : undefined,
    pendingApprovals: Array.isArray(payload.pendingApprovalRequests)
      ? payload.pendingApprovalRequests.length
      : undefined,
    pendingUserInputs: Array.isArray(payload.pendingUserInputRequests)
      ? payload.pendingUserInputRequests.length
      : undefined,
  };
}

async function submitPrompt(threadId) {
  if (!prompt) {
    return;
  }
  stats.submittedAt = Date.now();
  const response = await requestJson(`/v1/threads/${encodeURIComponent(threadId)}/input`, {
    method: "POST",
    body: JSON.stringify({ input: [{ type: "text", text: prompt }] }),
  });
  log("submitted input", { disposition: response.disposition });
}

function intervalReport() {
  const ms = elapsedMs();
  log("progress", {
    rawBytes: stats.rawBytes,
    raw: formatBytes(stats.rawBytes),
    rawPerMinute: formatBytes(bytesPerMinute(stats.rawBytes, ms)),
    events: stats.events,
    lastSeq: stats.lastSeq,
    topKinds: topKindRows(5),
  });
}

function topKindRows(limit = 20) {
  return [...stats.byKind.entries()]
    .map(([kind, value]) => ({
      kind,
      count: value.count,
      bytes: value.bytes,
      maxBytes: value.maxBytes,
      avgBytes: Math.round(value.bytes / value.count),
      avgRows: value.patchRowCountSamples ? Number((value.patchRows / value.patchRowCountSamples).toFixed(2)) : undefined,
      maxRows: value.maxPatchRows || undefined,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

function finalReport() {
  const observedMs = elapsedMs(stats.stoppedAt ?? Date.now());
  return {
    baseUrl,
    threadId: stats.threadId,
    createdThread: stats.createdThread,
    promptSubmitted: prompt !== null,
    observedSeconds: Number((observedMs / 1000).toFixed(3)),
    rawBytes: stats.rawBytes,
    rawHuman: formatBytes(stats.rawBytes),
    rawBytesPerMinute: Math.round(bytesPerMinute(stats.rawBytes, observedMs)),
    rawPerMinuteHuman: formatBytes(bytesPerMinute(stats.rawBytes, observedMs)),
    parsedEventBytes: stats.eventBytes,
    events: stats.events,
    eventsPerMinute: Number(((stats.events * 60000) / Math.max(observedMs, 1)).toFixed(2)),
    lastSeq: stats.lastSeq,
    patchScopes: Object.fromEntries([...stats.patchScopes.entries()].sort()),
    byKind: topKindRows(50),
    largestEvents: stats.largestEvents,
  };
}

async function main() {
  const threadId = await ensureThread();
  const cursor = await initialCursor(threadId);

  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const sse = startSse(threadId, cursor, resolveStop);
  const progressTimer = setInterval(intervalReport, reportIntervalMs);
  const timeoutTimer = setTimeout(() => {
    log("timeout");
    resolveStop();
  }, timeoutMs);

  await new Promise((resolve) => setTimeout(resolve, 250));
  await submitPrompt(threadId);
  await stopped;
  clearInterval(progressTimer);
  clearTimeout(timeoutTimer);
  sse.controller.abort();
  await sse.done.catch((error) => {
    if (error.name !== "AbortError") {
      throw error;
    }
  });
  console.log(JSON.stringify(finalReport(), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
