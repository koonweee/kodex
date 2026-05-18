---
name: thin-client-sse-debug
description: Debug Kodex gateway SSE behavior with a minimal HTTP/SSE client when browser UI state, live events, selected-thread updates, notifications, queues, approvals, or thread lifecycle appear out of sync.
---

# Thin Client SSE Debug

Use this skill when direct visibility into Kodex gateway SSE events would help debug behavior. Keep the client thin: avoid React, Vite, service workers, browser caches, and UI reducers unless the question specifically requires them.

## Workflow

1. Define the target and mutation level.
   - Attach to an existing thread when possible.
   - Create a new thread or submit input only when the user asked for a live end-to-end test.
   - If using a production DB or production-style gateway, state that the test will create durable gateway/app-server state before doing it.

2. Pick the gateway endpoint.
   - Prefer an already-running gateway when the user is testing the current app.
   - If starting an isolated gateway against a shared DB, use a non-default port and make the DB path explicit.
   - Disable unrelated subsystems that can interfere with startup, such as previews, when they are not under test.

3. Run the bundled thin client:

   ```bash
   node .codex/skills/thin-client-sse-debug/scripts/thin-sse-debug.mjs
   ```

4. Capture enough context to compare sources of truth:
   - SSE event arrival times relative to submit/connect.
   - Event counts by kind.
   - First patch, first delta, refresh-required, terminal/idle patch timings.
   - Final `GET /v1/threads/{threadId}` snapshot.
   - Optional DB event timing for the same thread when gateway persistence matters.

5. Report observations, not just logs.
   - Call out whether the thin client reproduced the issue.
   - Compare terminal backend events with selected SSE terminal events.
   - Identify whether the likely delay is backend/app-server, gateway fanout, browser/EventSource backlog, frontend reducer/render work, or timestamp-source mismatch.

## Script Configuration

Environment variables:

- `KODEX_BASE_URL`: gateway URL, default `http://127.0.0.1:8787`.
- `KODEX_THREAD_ID`: existing thread to observe.
- `KODEX_PROJECT_ID`: project to use when creating a thread.
- `KODEX_PROJECT_NAME`: project name to resolve through `GET /v1/projects`.
- `KODEX_CREATE_THREAD=1`: create a project thread before observing.
- `KODEX_PROMPT`: text input to submit to the observed thread.
- `KODEX_TIMEOUT_MS`: max run time; defaults to `300000` with a prompt and `30000` without one.
- `KODEX_STOP_ON_IDLE=0`: keep observing after a `thread_view.patch` reports `idle`.
- `KODEX_EVENT_KINDS`: comma-separated event kinds to log verbosely.
- `KODEX_LOG_ALL_EVENTS=1`: log every event summary.

Common examples:

```bash
KODEX_THREAD_ID=<thread-id> node .codex/skills/thin-client-sse-debug/scripts/thin-sse-debug.mjs
```

```bash
KODEX_BASE_URL=http://127.0.0.1:8791 \
KODEX_PROJECT_NAME=kodex \
KODEX_CREATE_THREAD=1 \
KODEX_PROMPT='when do we send notifications?' \
node .codex/skills/thin-client-sse-debug/scripts/thin-sse-debug.mjs
```

## Guardrails

- Do not read or print secrets from env files. Only inspect variable names or non-secret runtime values when needed.
- Do not assume SSE replay is canonical timeline history. Use selected-thread `thread_view.patch`, `thread_view.item_delta`, and final thread detail snapshots for visible timeline state.
- Do not leave temporary gateways running. Stop any isolated server started for the trace.
- Keep generated trace files in `/tmp` unless the user asks to save an artifact in the repo.
- Avoid committing trace output. Commit only reusable skill/script changes when requested or appropriate.
