# Generated UI Pane Plan

## Status

Complete. Implemented the backend session/store/API, Kodex Control tools and skill guidance, frontend split/sheet host, generated OpenAPI types, focused tests, docs, browser validation, and review fixes.

## Goal

Let Codex present a temporary, thread-bound interactive UI when HTML is a better medium than chat. The first version should let the LLM create a sandboxed generated UI pane, let the user interact with it locally, and require an explicit submit action that sends one normal, visible user message back to the active thread.

This feature extends the existing first-party Kodex Control plugin and gateway self-control surface. The plugin gives agents tools and guidance for opening/updating the pane; the gateway and web app own rendering, lifecycle, sandboxing, multi-client convergence, and submit routing.

## Settled Product Decisions

- v1 is submit-bounded, not close-bounded. User interactions remain local inside the iframe until the generated UI submits one message.
- The pane does not necessarily close after submit. The submitted revision becomes submitted, remains visible for reference, and Codex may rewrite/update the pane for a follow-up.
- Desktop UX splits the thread chat pane into two resizable columns: chat/timeline/composer on one side and generated UI on the other.
- Narrow/mobile UX shows the generated UI as a full-page bottom sheet, not a side drawer.
- The generated UI is bound to a thread. v1 shows only the latest generated UI session for a thread.
- The primary user dismissal action is local Hide. Hiding does not close/archive the session for other tabs. The latest session remains reopenable from a thread-header icon near the existing thread actions.
- Opening or materially updating the generated UI should be paired with a brief assistant message that orients the user without duplicating the UI.
- Codex may use generated UI proactively when the interaction is materially clearer as UI than chat. It should not open a pane for trivial prose or yes/no exchanges.
- Every submit must include a human-readable visible message. Optional JSON metadata may be stored for debugging/future tooling, but hidden metadata is not the canonical thread input.
- Submitted messages should be concise. The LLM guidance must tell Codex not to echo the entire generated UI or questionnaire back into chat unless the user explicitly asks.
- Iframe submit sends immediately. There is no native review/edit step in v1.
- Each render revision is one-submit by default. The gateway rejects duplicate submit for the same session revision.
- v1 trusts generated UI not to auto-submit. No arming handshake is planned initially.
- v1 allows arbitrary self-contained HTML/CSS/JS inside a sandboxed iframe, bounded by a tiny host protocol.
- v1 blocks arbitrary external network access for generated UI. This must be represented as a named network policy with code comments explaining how to relax it later through allowlists or approvals.
- Generated UI sessions are durable in SQLite so reloads, reconnects, and two tabs converge through gateway state.
- Initial persistence is intentionally small: keep the latest session document/status/submission per thread, not a full artifact history.
- Extend Kodex Control rather than creating a separate plugin in v1.

## Non-Goals

- No arbitrary external website/browser embedding.
- No Playwright/noVNC/live browser streaming.
- No persistent multi-artifact gallery or historical generated UI browser.
- No multiple visible generated UI sessions per thread.
- No hidden JSON-only submit path.
- No native review step before submit.
- No direct gateway API access from iframe JavaScript.
- No external scripts, remote images, fonts, beacons, forms, frames, or fetch/connect from generated UI in v1.
- No user-authored generated UI editor in v1.
- No app-server protocol changes unless thread input metadata later requires upstream support.

## Current Kodex Grounding

Backend:

- Public routes and OpenAPI registration live in `apps/gateway/src/api.rs`.
- Gateway events are persisted in `apps/gateway/src/store/events.rs` and streamed through `apps/gateway/src/events.rs` and `apps/gateway/src/routes/events.rs`.
- Gateway-owned SQLite migrations live in `apps/gateway/src/store/migrations.rs`.
- Normal composer submit routes through `POST /v1/threads/{threadId}/input` in `apps/gateway/src/routes/turns.rs`, which starts, steers, or queues according to gateway-owned lifecycle routing.
- Agent-facing self-control routes live in `apps/gateway/src/routes/self_control.rs` under `/v1/self-control/...`.
- Kodex Control MCP tools live in `apps/gateway/src/mcp.rs` and already call self-control endpoints over the local gateway.
- Project previews in `apps/gateway/src/previews.rs` and `apps/gateway/src/routes/project_previews.rs` are a precedent for gateway-owned UI-visible configuration plus status.

Frontend:

- `apps/web/src/shell/KodexShellView.tsx` currently switches between `thread`, `automations`, and `project` main panes.
- `apps/web/src/App.tsx` coordinates selected thread state, composer submit, live streams, subagent viewer, Markdown preview, and shell props.
- `apps/web/src/threads/ThreadPanel.tsx` owns the selected-thread timeline surface and header controls.
- `apps/web/src/composer/ComposerPanel.tsx` owns normal composer input.
- `apps/web/src/events/liveRouting.ts` is the existing place for routing gateway SSE events into frontend caches/state.
- `apps/web/src/api/client.ts` wraps generated OpenAPI types from `apps/web/src/api/generated/schema.ts`.

Plugin:

- The first-party plugin package is `plugins/kodex-control/`.
- Its manifest is `plugins/kodex-control/.codex-plugin/plugin.json`.
- The plugin currently has a preview-focused skill at `plugins/kodex-control/skills/kodex-proxy-evaluation/SKILL.md`.
- The MCP server wrapper is declared by `plugins/kodex-control/.mcp.json` and implemented through the gateway subcommand.

## UX Contract

Visual reference:

- Use [generated-ui-pane-contact-sheet.png](assets/generated-ui-pane-contact-sheet.png) as the implementation design reference for the v1 layout states: desktop split, hidden-session header icon, mobile full-page bottom sheet, and submitted revision. The implementation should match the product behavior shown there, while preserving existing Kodex component patterns and responsive constraints.

Desktop:

- When a selected thread has a visible generated UI session, the thread main area becomes a horizontal split.
- Left column: existing selected thread timeline and composer.
- Right column: generated UI pane.
- The split is resizable with sane minimums, for example chat min about `420px` and generated UI min about `360px`, adjusted to existing layout constraints.
- The generated UI pane has host chrome: title, status/submitted indicator, Hide, and optional reopen affordance from the thread header.
- The generated UI content itself should not be wrapped in nested cards. The iframe should occupy the pane body.

Mobile/narrow:

- Generated UI appears as a full-page bottom sheet over the thread view, entering from the bottom rather than sliding in from the side.
- The sheet should feel like a primary mobile surface: full viewport height, safe-area aware, with a compact top handle/header, title, submitted state, and Hide/Close.
- New session revisions should reopen the sheet even if the previous revision was hidden locally.

Local visibility:

- Hide is browser-local and scoped to a session id plus revision. Hiding one tab does not close the pane for other tabs.
- A new session or new revision should clear the local hidden state so material Codex updates are visible.
- When the latest generated UI session exists but is locally hidden, the thread header should show a generated-UI icon button near the existing three-dot/thread actions area. The icon reopens the split pane or mobile bottom sheet and should expose a clear tooltip/accessibility label such as "Show generated UI".
- Shared close/archive is not the primary v1 user control. Codex can replace/update the latest session; explicit shared archive can be added if needed.

Submit behavior:

- The generated UI calls the host protocol with `{ message, metadata? }`.
- The parent/gateway immediately submits `message` as a normal text input to `POST /v1/threads/{threadId}/input`.
- The submitted message appears in the conversation like user composer input.
- The gateway records generated UI provenance and optional metadata separately from the visible message.
- After successful submit, the submitted revision can no longer submit again.
- If submit fails, the pane should show a native host error and keep the revision submit-capable unless the gateway recorded a successful submission.

## Iframe Runtime And Protocol

The generated document should be self-contained HTML/CSS/JS rendered in a sandboxed iframe served by the gateway, not `srcdoc`, so the gateway can attach deterministic CSP headers.

Suggested iframe sandbox:

```html
<iframe sandbox="allow-scripts" />
```

Do not use `allow-same-origin` in v1. The iframe should have an opaque origin and should not receive gateway cookies or same-origin privileges.

Suggested gateway document route headers:

```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy:
  default-src 'none';
  script-src 'unsafe-inline';
  style-src 'unsafe-inline';
  img-src data: blob:;
  font-src data:;
  connect-src 'none';
  form-action 'none';
  frame-src 'none';
  base-uri 'none'
```

The exact CSP may need browser validation, but the implementation should keep the named intent: inline code is allowed; external network is not.

Minimal host protocol:

```ts
type GeneratedUiReadyMessage = {
  type: "kodex.ui.ready";
  sessionId: string;
  revision: number;
};

type GeneratedUiResizeMessage = {
  type: "kodex.ui.resize";
  sessionId: string;
  revision: number;
  height?: number;
};

type GeneratedUiSubmitMessage = {
  type: "kodex.ui.submit";
  sessionId: string;
  revision: number;
  message: string;
  metadata?: unknown;
};
```

Validation rules:

- Parent accepts messages only from the active iframe `contentWindow`.
- Message `sessionId` and `revision` must match the loaded session.
- `message` must be non-empty after trimming and within a bounded size.
- `metadata` must be JSON-serializable and within a bounded size.
- Parent should ignore unknown message types.
- Gateway must enforce duplicate-submit protection by session id and revision. Frontend-only disabled state is not sufficient.

## Data Model Direction

Add a small gateway-owned table, likely in `apps/gateway/src/store/migrations.rs`, to keep the latest generated UI session per thread:

```sql
create table if not exists generated_ui_sessions (
    id text primary key,
    thread_id text not null unique,
    title text not null,
    html text not null,
    revision integer not null,
    status text not null,
    submitted_revision integer,
    submitted_message text,
    submitted_metadata_json text,
    created_at text not null,
    updated_at text not null,
    submitted_at text,
    archived_at text
);
```

Notes:

- The `thread_id` unique constraint encodes "latest session per thread" for v1.
- Updating the pane increments `revision`, replaces `html`, resets submit availability for the new revision, and emits a session upsert event.
- `submitted_metadata_json` is stored for audit/debug/future tools, not sent as hidden model context by default.
- If richer history becomes necessary, add `generated_ui_session_revisions` later instead of overloading the v1 table.

## API Shape

Public web routes:

- `GET /v1/threads/{threadId}/generated-ui`
  - returns the latest session for the thread, if any.
- `GET /v1/generated-ui/sessions/{sessionId}/document?revision={revision}`
  - serves sandboxed HTML with CSP.
- `POST /v1/generated-ui/sessions/{sessionId}/submit`
  - validates revision/message/metadata, records the submission, submits normal thread input, and returns thread input disposition.
- `POST /v1/generated-ui/sessions/{sessionId}/hide` is not needed because hide is local browser state.

Self-control routes:

- `POST /v1/self-control/threads/{threadId}/generated-ui`
  - upserts/replaces the latest generated UI session for the thread.
- `DELETE /v1/self-control/threads/{threadId}/generated-ui`
  - archives the latest session if a shared close/archive action is needed by Codex.
- `GET /v1/self-control/threads/{threadId}/generated-ui`
  - reads session metadata and optionally document content for agent continuation/debugging.

SSE events:

- `generated_ui.session_upserted`
- `generated_ui.session_submitted`
- `generated_ui.session_archived`

These events should be replayable enough for tabs to converge, and selected-thread fetch should still be the source of truth after reconnect uncertainty.

## Kodex Control Tools And Skill Guidance

Add MCP tools in `apps/gateway/src/mcp.rs` that call the new self-control routes:

- `open_generated_ui`
- `update_generated_ui`
- `get_generated_ui`
- `archive_generated_ui`

The tool descriptions and plugin skill guidance should teach the LLM:

- Use generated UI when the user benefits from direct manipulation, visual comparison, forms, sliders, mockups, structured questionnaires, or small task-specific tools.
- Do not use generated UI for simple prose answers, ordinary code diffs, or trivial yes/no questions.
- Always include a concise assistant message explaining what the pane is for.
- Make every generated UI responsive; it must work in a desktop side pane and mobile full-height sheet.
- Include an obvious submit control for meaningful output.
- Submit concise human-readable messages. Do not echo the full UI, all options, or large form schema back into chat unless asked.
- Use optional metadata for structured answers, not as a hidden substitute for the visible message.
- Do not auto-submit on load.
- Do not request secrets, credentials, or sensitive data in generated UI.
- Keep UI self-contained; no remote scripts/assets/network.
- Prefer semantic HTML controls, labels, focus states, and keyboard-friendly interactions.

Add a dedicated skill under the existing plugin, for example:

- `plugins/kodex-control/skills/generative-ui/SKILL.md`

Update `plugins/kodex-control/.codex-plugin/plugin.json` keywords/description only as needed.

## Milestones

### 1. Backend Session Model And Contract Tests

Scope: `apps/gateway/src/store/migrations.rs`, `apps/gateway/src/store.rs` or a new store module, `apps/gateway/src/routes/generated_ui.rs`, `apps/gateway/src/api.rs`.

Work:

- Start with failing backend tests for session upsert, latest-per-thread replacement, revision increment, duplicate submit rejection, and archive behavior.
- Add generated UI DTOs with `utoipa::ToSchema`.
- Add SQLite migration and store helpers for latest session by thread.
- Add public read and document-serving routes.
- Serve the document with sandbox-oriented CSP and document the named network policy in code.
- Register routes and schemas in `apps/gateway/src/api.rs`.

Exit criteria:

- Focused backend tests pass.
- `/openapi.json` includes generated UI session DTOs and routes.
- Document route tests assert CSP contains `connect-src 'none'` and no external default source.

### 2. Submit Routing And Gateway Events

Scope: `apps/gateway/src/routes/generated_ui.rs`, `apps/gateway/src/routes/turns.rs` helper seams if extraction is needed, `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/store/events.rs`.

Work:

- Add `POST /v1/generated-ui/sessions/{sessionId}/submit`.
- Validate revision, message length, metadata size, and session/thread consistency.
- Record submission before or atomically with duplicate-submit protection so refresh/retry cannot double-send.
- Route submitted visible message through existing gateway thread input semantics.
- Record provenance linking the input to session id and revision where existing queue/source seams allow it.
- Emit generated UI upsert/submitted/archive events.
- Ensure selected-thread and global SSE clients converge through events plus refetch.

Exit criteria:

- Backend tests cover idle-thread submit, active-thread submit according to existing gateway routing, duplicate submit rejection, metadata storage, and event payloads.
- Same-user two-tab shape is covered at least at route/event level: one client submits, another can refetch and see submitted state.

### 3. Self-Control And Kodex Control MCP Tools

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/mcp.rs`, `plugins/kodex-control/.mcp.json` if needed.

Work:

- Add self-control endpoints for upsert/read/archive generated UI.
- Add MCP tools that call those endpoints.
- Include tool descriptions that require a brief assistant explanation after opening/updating the pane.
- Return concise tool results by default: session id, revision, title, status, and whether submit is available. Avoid returning full HTML unless the tool explicitly reads it.
- Add bounded parameter schemas for `title`, `html`, optional `initialState`/metadata, and provenance.

Exit criteria:

- MCP handler tests cover tool listing and one upsert/read flow against a test gateway.
- Self-control tests cover provenance and latest-session replacement.
- Existing Kodex Control MCP tests continue passing.

### 4. Frontend API, State, And Live Routing

Scope: `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, `apps/web/src/events/liveRouting.ts`, new `apps/web/src/generatedUi/` module, generated OpenAPI types.

Work:

- Regenerate frontend OpenAPI types after backend DTOs land.
- Add typed client wrappers and query keys.
- Add a generated UI cache/state helper for session upsert/submitted/archive events.
- Fetch latest generated UI for the selected thread.
- Keep local hide state scoped by `sessionId:revision`.
- Clear local hide when a new revision arrives.

Exit criteria:

- Focused frontend tests cover cache updates, hide scoping, new-revision reveal, and submitted-state convergence from SSE/refetch.
- `cd apps/web && npm test` focused generated UI/event suites pass.

### 5. Frontend Split Pane And Iframe Host

Scope: `apps/web/src/shell/KodexShellView.tsx`, `apps/web/src/threads/ThreadPanel.tsx`, `apps/web/src/App.tsx`, new `apps/web/src/generatedUi/GeneratedUiPane.tsx`, CSS under `apps/web/src/styles/`.

Work:

- Add a generated UI host pane that renders the sandboxed iframe.
- Add desktop horizontal split around the selected thread chat area and generated UI pane.
- Add resizable divider with minimum widths and keyboard-accessible resizing if consistent with existing sidebar resize behavior.
- Add mobile full-page bottom sheet behavior, entering from the bottom and avoiding side-drawer presentation.
- Add thread-header reopen affordance near existing thread action controls when the latest session exists but is locally hidden.
- Implement `postMessage` validation for ready/resize/submit.
- Submit immediately through the generated UI submit endpoint.
- Disable duplicate submit after submitted revision state is returned or observed.
- Show concise host-level errors for invalid/failed submits.

Exit criteria:

- Component tests cover iframe src construction, submit postMessage handling, invalid session/revision rejection, duplicate submitted-state disabled UI, desktop split render, and mobile sheet render.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validation covers desktop split resizing, narrow viewport/mobile bottom sheet, hidden-session header icon/reopen behavior, submit flow visibility in the chat transcript, hide/reopen behavior, and no obvious overlap or text clipping.

### 6. Plugin Skill Guidance And Docs

Scope: `plugins/kodex-control/skills/generative-ui/SKILL.md`, `plugins/kodex-control/README.md`, `README.md`, `plans/index.md`, `AGENTS.md` only if contributor workflow changes.

Work:

- Add the generated UI skill/guidance to Kodex Control.
- Document intended LLM usage, responsive requirements, submit message discipline, one-submit revisions, sandbox/network limits, and examples such as `$grill-me` questionnaires and mockup comparison.
- Update Kodex Control README and root README with user-visible behavior and local/trusted deployment assumptions.
- Update `plans/index.md` status as implementation progresses.

Exit criteria:

- Skill instructions are concise enough to guide agents without encouraging context-heavy submissions.
- README documents that generated UI is sandboxed self-contained HTML and blocks external network by default.
- No stale docs imply generated UI can browse arbitrary websites.

### 7. End-To-End Verification And Review

Scope: backend tests, frontend tests/build, generated API artifacts, browser validation, review gate.

Work:

- Run `cargo fmt`.
- Run focused backend tests, then broader `cargo test` if cost is acceptable.
- Regenerate `apps/web/src/api/generated/schema.ts`.
- Run focused frontend tests and `cd apps/web && npm run build`.
- Run `$agent-browser` against a local dev/prod build for the UX paths listed above.
- Run an independent review pass per repo workflow and fix major findings.

Exit criteria:

- Generated OpenAPI and frontend types are current.
- Tests/build pass or failures are documented with concrete blockers.
- Browser validation screenshots/interactions confirm desktop and mobile behavior.
- Review gate finds no major unresolved issues.

## Verification Matrix

- Backend: session store, routes, CSP, duplicate submit, submit routing, events, MCP tools.
- Frontend: cache convergence, split layout, mobile sheet, postMessage validation, hide/reopen, submit result rendering.
- Multi-client: one tab receives a new session/update/submission from another tab through gateway-owned events/refetch; local Hide remains local.
- Security: iframe has no same-origin privileges; CSP blocks external network; submit validates session/revision/message/metadata sizes.
- LLM usage: plugin skill/tool descriptions encourage proactive but bounded use and concise submits.

## Risks And Open Questions

- CSP details may need browser iteration because sandboxed opaque-origin iframes and inline scripts can behave differently across browsers. Resolve through `$agent-browser` and targeted unit/integration tests.
- If users expect editing the submitted message before send, v1 intentionally does not provide it. Revisit only if immediate submit causes real trust issues.
- The normal `/v1/threads/{threadId}/input` route can steer active turns, while self-control input currently queues active threads. Generated UI submit should follow normal composer behavior by product decision; implementation must avoid accidentally using the self-control active-thread queue policy.
- Large generated HTML could bloat SQLite and API responses. Add size limits early and avoid returning full HTML in live event payloads or default MCP results.
- The LLM that created the UI has its content in current context, but future turns may not. Keep session read tools available while still guiding agents to avoid dumping full UI content into chat.
