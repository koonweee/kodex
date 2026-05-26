# Agent Instructions

This repository contains the Kodex monorepo: a Rust Codex gateway plus a planned React web frontend.

## Required Workflow

- Start behavior-changing implementation work with a failing test when practical. Match test coverage to risk and user-visible behavior using unit, integration, contract, or Playwright tests as appropriate.
- Pure styling, copy, layout-only, mechanical refactors, and tiny low-risk changes do not require new tests unless they protect existing regression-prone behavior.
- Keep code DRY. Add shared helpers only when they remove real duplication or clarify a repeated contract.
- Follow YAGNI. Do not build features outside the active plan milestone unless the current change requires them.
- Treat generated OpenAPI as the public API contract. Public request/response DTOs live in Rust code and must generate `/openapi.json`.
- When integrating with the Codex app-server, treat the checked-in generated schemas and the upstream app-server README as the source of truth. Verify request/response shapes, lifecycle rules, and transport assumptions against `apps/gateway/app-server-schema/<version>/json` and https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md instead of inferring behavior from gateway code or handwritten notes.
- For official real-client behavior examples, the upstream Codex TUI is a useful reference: https://github.com/openai/codex/tree/main/codex-rs/tui/src. Use it to understand client sequencing, UI-facing lifecycle handling, and edge cases, but do not treat it as the wire contract when it conflicts with the generated schemas or app-server README.
- Do not create separate handwritten API contract docs unless a specific implementation issue requires explanatory prose.
- Frontend API types must come from generated OpenAPI artifacts, not ad hoc duplicate TypeScript interfaces.
- Prefer small, milestone-scoped changes that keep the repo runnable.
- Keep local/VPN-only deployment assumptions explicit. Do not imply the gateway is safe to expose publicly.

## Coding Workflow

- Work in small, reviewable chunks tied to the active milestone.
- Commit frequently at coherent boundaries, after tests pass and relevant docs are updated.
- Keep each commit focused on one sensible unit of work.
- Do not mix unrelated changes in a commit.
- Do not commit generated output, user-owned changes, or unrelated workspace changes unless they are part of the current task.
- Do not mark a milestone complete until its exit conditions are met.

## Backend Commands

- Format Rust code with `cargo fmt`.
- Run backend tests with `cargo test`.
- Start the gateway with `cargo run -p kodex-gateway`.
- Inspect generated API contract at `GET /openapi.json`; local API docs are served at `GET /docs`.
- The default database is `~/.kodex/gateway.db`; use `KODEX_DATABASE_PATH` or `KODEX_DATA_DIR` for local overrides.
- Keep the configured `codex` binary version matched to the checked-in `apps/gateway/app-server-schema/<version>/VERSION` schema version.
- Regenerate the checked-in Codex app-server JSON Schema with `apps/gateway/scripts/generate-app-server-schema.sh` after changing the Codex binary version; schemas are always generated with experimental API output enabled.

## Frontend Commands

- Install frontend dependencies with `cd apps/web && npm install`.
- Start the Vite dev server with `cd apps/web && npm run dev`; it proxies `/v1` and `/openapi.json` to `127.0.0.1:8787` unless `VITE_KODEX_API_BASE_URL` is set.
- Run frontend unit/component tests with `cd apps/web && npm test`.
- Run frontend Playwright flows with `cd apps/web && npm run test:e2e`.
- Build frontend assets with `cd apps/web && npm run build`.
- Regenerate frontend OpenAPI types with a gateway running, then `cd apps/web && npm run generate:api`.
- The generated OpenAPI TypeScript output is committed at `apps/web/src/api/generated/schema.ts`; do not hand-write duplicate gateway DTO interfaces.

## Frontend Code Organization

- Keep `apps/web/src/App.tsx` as the shell coordinator. New feature behavior belongs in a feature module, hook, reducer, or component under a domain directory such as `timeline`, `composer`, `approvals`, `threads`, `events`, `api`, or theme/preferences modules.
- Do not add unrelated responsibilities to an already-large file. If a source file is approaching 500 lines, extract before adding more behavior. If a test file is approaching 800 lines or a CSS file is approaching 600 lines, split it by workflow or feature.
- Keep ownership boundaries explicit: API calls in `api`, SSE in `events`, timeline state and presentation in `timeline`, composer behavior in `composer`, approval behavior in `approvals`, thread/project navigation in `threads`, and theme/preferences in their existing modules.
- Prefer pure helper modules for payload normalization, reducer transformations, and decision construction. Components should mostly render and delegate side effects through props or hooks.
- New frontend behavior should add or update the closest domain test. Avoid growing broad app-level MVP tests unless the behavior genuinely spans multiple domains.
- When a feature needs app-server raw payload interpretation, isolate it in a named normalization helper and cover it with focused tests.
- Use plain Mantine controls first for baseline form, menu, modal, drawer, button, badge, tab, segmented-control, and alert chrome. Add app-wide control defaults in `apps/web/src/theme/components.ts` and `apps/web/src/styles/mantine-components.css`; keep feature CSS for layout, density, and one-off behavior.

## Frontend Responsive Styling

- Treat viewport width and input modality as separate concerns. Use width breakpoints for structural layout and content fit, such as the single-panel shell, table-to-card transforms, stacked forms, hidden side panes, and bounded image grids.
- Use shared frontend input-capability helpers or hooks for touch/coarse-pointer decisions instead of ad hoc `matchMedia` or `navigator.maxTouchPoints` checks in feature components.
- Scope touch ergonomics to touch/coarse-pointer devices: 44px tap targets, 16px editable inputs for iOS zoom avoidance, safe-area and visual-viewport keyboard handling, touch scrolling, bottom sheets, and controls that must be visible without hover.
- Keep fine-pointer hover affordances behind hover-capable media queries or explicit pointer handling, and make sure touch users have a non-hover path to the same actions.
- When changing responsive UI behavior, test at least desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes if the feature has both layout and input-modality behavior.

## Multi-Client State Ownership

- Design the web client as a thin projection of gateway-owned state. Any state that must be correct across two browser tabs, reloads, reconnects, or future clients must live in the gateway or upstream app-server, not only in React state.
- Browser-local state is appropriate for drafts, focus, hover, modals, scroll, drag interactions, unsent attachments, and other purely visual or per-tab UI concerns.
- The gateway must own shared lifecycle decisions: active or pending turn state, queued or pending submitted input, interrupt and steer routing, read receipts, thread completion counters, approval state, account/session state, thread settings, archive/fork/title metadata, and sidebar ordering when ordering affects selection or read state.
- Do not make the browser decide shared command routing from stale local state. Prefer gateway commands that atomically inspect current gateway/app-server state, then return or emit the authoritative result.
- Optimistic UI is allowed only as a temporary projection of a gateway-owned pending record, or when incorrect cross-client visibility is harmless. If another tab should know about it, create a gateway row/event for it.
- Do not derive durable counters, lifecycle status, or ordering from client-observed event order unless the gateway provides a monotonic sequence or watermark that makes the derivation safe.
- Snapshot and SSE reconciliation must have a gateway-owned source of truth. Snapshots that can overwrite live state should carry a comparable sequence/runtime watermark, or the gateway should emit ordered canonical snapshot events.
- Visible thread timeline rendering must consume gateway canonical thread view snapshots, `thread_view.patch`, and canonical text-only `thread_view.item_delta` events only. Do not render app-server item/turn lifecycle directly from raw SSE events such as `timeline.item_delta`, and do not reintroduce persisted timeline replay as browser transcript history.
- `thread_view.refresh_required` is a refetch signal, not a timeline row source. Browser reducers may advance cursors from it, but must converge by reading the gateway thread detail snapshot.
- Browser read/unread projections must converge from gateway-owned `thread.read_updated` events or refetched thread summaries. Do not increment completed-turn read counters in React state as durable truth.
- Selected-thread Stop must route through `POST /v1/threads/{threadId}/interrupt-current`; the browser must not choose the interrupted turn from local `activeTurnId` except for explicit turn-id API utilities.
- Existing-thread turn input options are per-turn or per-queued-row submission data. Normal sends must not persist a browser-submitted full options object as future thread settings.
- Keep guardrail tests updated when changing lifecycle event names. A behavior change that adds a new browser-visible lifecycle event should fail loudly unless the canonical source-of-truth contract is updated in code and docs.
- Thread/session settings that affect future turns must be versioned or merged by the gateway. A stale tab must not be able to silently overwrite newer shared settings by submitting a full local options object.
- Any behavior-changing feature that touches shared thread/project/session state should include a same-user, two-tab test shape: one client mutates or misses events, and the other must converge through gateway state/SSE without reload.

## Parallel Work

- Use subagents for independent, parallelizable work when the active environment and instructions permit it.
- Give subagents bounded ownership of files, modules, or questions.
- Do not delegate work that blocks the immediate next local step.
- Avoid duplicating work between the main agent and subagents.
- Integrate and review subagent output before considering the milestone complete.

## Review Gate

- Every implementation chunk requires an independent review pass before completion.
- Prefer a review subagent when available and permitted.
- If no review subagent is available, perform a self-review and document what was checked.
- Iterate until tests pass, docs are updated, and the active milestone exit conditions are satisfied.
- Before marking frontend lifecycle work complete, check whether the behavior remains correct with two tabs open on the same gateway. If correctness depends on one tab's React state, move the source of truth to the gateway or document why the state is intentionally per-tab.
- Do not mark work complete while tests, docs, generated OpenAPI artifacts, generated frontend API types, or exit conditions are failing.

## Documentation Discipline

- Keep [plans/index.md](plans/index.md) up to date whenever a plan status changes.
- Update `README.md` when setup, commands, security assumptions, or project structure change.
- Update this `AGENTS.md` when contributor workflow, testing rules, or project constraints change.
- If implementation details diverge from a plan, update the relevant plan before or in the same change.

## Plan References

- Backend MVP: [plans/mvp-backend.md](plans/mvp-backend.md)
- Frontend MVP: [plans/mvp-frontend.md](plans/mvp-frontend.md)
- Future extensions: [plans/future-extensions.md](plans/future-extensions.md)

## Initial Architecture Constraints

- Monorepo from scratch.
- Backend stack: Rust, `axum`, `tokio`, `sqlx`, SQLite WAL.
- Frontend stack: React, Vite, TypeScript.
- API contract stack: Rust DTOs plus generated OpenAPI, with frontend-generated TypeScript types/client.
- Gateway talks to a configured external `codex` binary over stdio.
- Gateway serves the built frontend in production.
- SSE is the first event transport.
- WebSocket is deferred until a feature requires bidirectional browser transport.
- MVP gateway auth is omitted because deployment is localhost or trusted VPN only.
- ChatGPT/Codex auth is handled through app-server account APIs.
