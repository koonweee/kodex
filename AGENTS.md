# Agent Instructions

This repository contains the Kodex monorepo: a Rust Codex gateway plus a planned React web frontend.

## Required Workflow

- Start behavior-changing implementation work with a failing test when practical. Match test coverage to risk and user-visible behavior using unit, integration, contract, or Playwright tests as appropriate.
- Pure styling, copy, layout-only, mechanical refactors, and tiny low-risk changes do not require new tests unless they protect existing regression-prone behavior. Do not add low-value tests that only assert CSS declarations, class names, z-index numbers, theme-token wiring, config constants, or other implementation strings for simple visual/config tweaks; verify those changes through build/typecheck, trim scripts, or manual UI inspection instead.
- Keep style-related assertions only when they protect behavior that is hard to verify otherwise, such as generated document contracts, runtime layout state, resize behavior, text wrapping, viewport/keyboard handling, Markdown semantics, or live theme recomputation.
- When trimming tests, remove assertions that merely duplicate implementation details while preserving coverage for user-visible behavior, state transitions, API calls, accessibility roles/names, shared-state convergence, and cross-client contracts.
- Use `$agent-browser` for browser-observable frontend validation when layout, visual rendering, responsive behavior, input modality, console cleanliness, same-user two-tab behavior, or live gateway/SSE flows need real-browser evidence. Prefer it alongside Playwright e2e for flows that are difficult to assert reliably in automated tests.
- Keep code DRY. Add shared helpers only when they remove real duplication or clarify a repeated contract.
- Follow YAGNI. Do not build features outside the active plan milestone unless the current change requires them.
- Prefer native app-server primitives and semantics. Accept native behavior and limitations by default instead of adding machinery to preserve old semantics; do not turn each native simplification into a separate approval gate. Before retaining or adding custom behavior that app-server lacks, justify the concrete user need, the simpler native workflow, and the ongoing state, retry, synchronization, and testing cost. Existing implementation alone does not justify preserving a feature; simplify or remove the feature when that better serves a thin, responsive client. Preserve explicitly retained workflows and correctness guarantees.
- Replace old subsystems outright when a fresh implementation around current native primitives is simpler than adapting the existing code. Retained features preserve intended workflows, not old modules, state models, internal APIs, or implementation-specific tests. Remove superseded code, unused tables from the fresh schema, dependencies and obsolete tests with the replacement; preserve meaningful behavior coverage and update generated contracts/callers together. Keep replacements scoped and reviewable, but do not force incremental patches or compatibility layers merely to reuse old code. Leave old user storage untouched.
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
- For the installed macOS login service, use `~/.local/share/kodex/kodex-service update` only when deployment is requested; `restart` does not build. When a full deployment changes the service controller itself, run `./tools/kodex-service update` from the tested checkout so the new packaging logic applies on that first update. The service downloads the official runtime pinned to the checked-in schema; do not source it from desktop app internals. Follow [docs/macos-service.md](docs/macos-service.md). Do not use the legacy tmux restart workflow to update a launchd-managed instance. Service-tool changes use `python3 -m unittest discover -s tools/tests -p 'test_kodex_service.py'`; live lifecycle checks affect the running service and need deployment scope.
- Keep each commit focused on one sensible unit of work.
- For explicitly requested frontend-only deployment, use `./tools/kodex-service update-frontend --repo "$PWD"` until the installed controller includes that command. This path requires a running compatible gateway and must not restart it; use a full update for changes requiring new backend behavior. Deploy a clean checkout or committed snapshot when unrelated edits are in progress. See [docs/macos-service.md](docs/macos-service.md).
- Do not mix unrelated changes in a commit.
- Do not commit generated output, user-owned changes, or unrelated workspace changes unless they are part of the current task.
- When changing `plugins/kodex-control`, update `.codex-plugin/plugin.json` with a Codex cachebuster version suffix before reinstalling so the installed plugin cache refreshes. If the Codex plugin-creator skill is installed, prefer its `update_plugin_cachebuster.py` helper, which preserves the base version and rewrites only the `+codex...` suffix.
- Before pushing, run the relevant trim script for changed code and remove unused code/dependencies surfaced by it to keep the codebase maintainable: `./tools/trim-backend.sh` for Rust changes and `./tools/trim-frontend.sh` or `cd apps/web && npm run trim` for frontend changes. If a trim script reports pre-existing unrelated findings, do not broaden the cleanup without user agreement; document the remaining findings.
- Before pushing, check `target` size with `du -sh target 2>/dev/null`; if it is over 6 GB, run `cargo clean` before pushing.
- Do not mark a milestone complete until its exit conditions are met.

## Backend Commands

- Format Rust code with `cargo fmt`.
- Run backend tests with `cargo test`.
- Check backend unused code and dependencies with `./tools/trim-backend.sh`.
- Start the gateway with `cargo run -p kodex-gateway`.
- Inspect generated API contract at `GET /openapi.json`; local API docs are served at `GET /docs`.
- During the native redesign, use disposable `KODEX_DATA_DIR` instance roots. The new default database is `~/.kodex/native-v1/gateway.db`; `KODEX_DATABASE_PATH` must resolve to `<instance root>/gateway.db`. Old stores are not opened or imported.
- Keep the configured `codex` binary version matched to the checked-in `apps/gateway/app-server-schema/<version>/VERSION` schema version.
- Regenerate the checked-in Codex app-server JSON Schema with `bash apps/gateway/scripts/generate-app-server-schema.sh <version> /absolute/path/to/codex` after changing the Codex binary version; the generator verifies that executable and always enables experimental output.

## Frontend Commands

- Install frontend dependencies with `cd apps/web && npm install`.
- Start the Vite dev server with `cd apps/web && npm run dev`; it proxies `/v1` and `/openapi.json` to `127.0.0.1:8787` unless `VITE_KODEX_API_BASE_URL` is set.
- Run frontend unit/component tests with `cd apps/web && npm test`.
- Run frontend Playwright flows with `cd apps/web && npm run test:e2e`.
- Build frontend assets with `cd apps/web && npm run build`.
- Check frontend unused files, exports, dependencies, locals, and parameters with `./tools/trim-frontend.sh` from the repo root, or `cd apps/web && npm run trim`.
- Regenerate frontend OpenAPI types from the checkout’s Rust exporter (no running gateway required): `cd apps/web && npm run generate:api`.
- The generated OpenAPI TypeScript output is committed at `apps/web/src/api/generated/schema.ts`; do not hand-write duplicate gateway DTO interfaces.

## Frontend Code Organization

- Keep `apps/web/src/App.tsx` as the shell coordinator. New feature behavior belongs in a feature module, hook, reducer, or component under a domain directory such as `timeline`, `composer`, `approvals`, `threads`, `events`, `api`, or theme/preferences modules.
- Do not add unrelated responsibilities to an already-large file. If a source file is approaching 500 lines, extract before adding more behavior. If a test file is approaching 800 lines or a CSS file is approaching 600 lines, split it by workflow or feature.
- Keep ownership boundaries explicit: API calls in `api`, SSE in `events`, timeline state and presentation in `timeline`, composer behavior in `composer`, approval behavior in `approvals`, thread/project navigation in `threads`, and theme/preferences in their existing modules.
- Prefer pure helper modules for payload normalization, reducer transformations, and decision construction. Components should mostly render and delegate side effects through props or hooks.
- New frontend behavior should add or update the closest domain test. Avoid growing broad app-level MVP tests unless the behavior genuinely spans multiple domains.
- When a feature needs app-server raw payload interpretation, isolate it in a named normalization helper and cover it with focused tests.
- Use plain Mantine controls first for baseline form, menu, modal, drawer, button, badge, tab, segmented-control, and alert chrome. Add app-wide control defaults in `apps/web/src/theme/components.ts` and `apps/web/src/styles/mantine-components.css`; keep feature CSS for layout, density, and one-off behavior.
- Follow [theme contrast guidelines](docs/theme-guidelines.md) when adding themes or styling surfaces. Validate foreground/background pairs and rendered control states using the opt-in theme contact sheet; do not assume a Mantine color prop or a passing panel token guarantees contrast on every surface.

## Frontend Responsive Styling

- Treat viewport width and input modality as separate concerns. Use width breakpoints for structural layout and content fit, such as the single-panel shell, table-to-card transforms, stacked forms, hidden side panes, and bounded image grids.
- Use shared frontend input-capability helpers or hooks for touch/coarse-pointer decisions instead of ad hoc `matchMedia` or `navigator.maxTouchPoints` checks in feature components.
- Scope touch ergonomics to touch/coarse-pointer devices: 44px tap targets, 16px editable inputs for iOS zoom avoidance, safe-area and visual-viewport keyboard handling, touch scrolling, bottom sheets, and controls that must be visible without hover.
- Keep fine-pointer hover affordances behind hover-capable media queries or explicit pointer handling, and make sure touch users have a non-hover path to the same actions.
- When changing responsive UI behavior, test at least desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes if the feature has both layout and input-modality behavior.

## Multi-Client State Ownership

- Design the web client as a thin projection of authoritative app-server or gateway state. Any state that must be correct across two browser tabs, reloads, reconnects, or future clients must live in the gateway or upstream app-server, not only in React state. Prefer native ownership; the gateway's routing/projection responsibility does not require a duplicate durable store for native state.
- Browser-local state is appropriate for drafts, focus, hover, modals, scroll, drag interactions, unsent attachments, and other purely visual or per-tab UI concerns.
- The sidebar supports Pinned, Projects and standalone Chats only. Pinned membership and order come from native reads; custom section management, public section DTOs/routes, section caches and local section database state are outside scope. Do not restore local pin flags/timestamps, prior-section tracking or activity-based sorting. Successful pin mutations publish a refill marker because the pinned native runtime has no section notification; reconnect and foreground recovery must cancel stale reads and converge from native snapshots. Existing native custom-section membership must not hide a chat from normal project/chat lists.
- Shared lifecycle decisions must be authoritative in app-server or the gateway: active or pending turn state, queued or pending submitted input, interrupt and steer routing, read receipts, native completion heads, approval state, account/session state, thread settings, archive/fork/title metadata, and sidebar ordering when ordering affects selection or read state. Delegate native decisions and persistence to app-server; retain gateway coordination only where the supported native contract requires it.
- Do not make the browser decide shared command routing from stale local state. Prefer gateway commands that atomically inspect current gateway/app-server state, then return or emit the authoritative result.
- Optimistic UI is allowed only as a temporary projection of an authoritative native/gateway pending operation, or when incorrect cross-client visibility is harmless. If another tab should know about it, expose authoritative state and convergence events through the gateway; native persistence does not require a second gateway row.
- Do not derive durable counters, lifecycle status, or ordering from client-observed event order unless the gateway provides a monotonic sequence or watermark that makes the derivation safe.
- Snapshot and SSE reconciliation must have a gateway-owned source of truth. Snapshots that can overwrite live state should carry a comparable sequence/runtime watermark, or the gateway should emit ordered canonical snapshot events.
- Keep the transport replay cursor, applied projection revision and full-snapshot coverage distinct. A newer partial patch does not prove that earlier text was included. Uncertain late partial updates must converge through the existing canonical snapshot read; do not add per-row ledgers or render raw native events. Live operational invalidations created after replay must not be discarded merely because another publisher delivered a higher cursor first.
- Allocate a projection cursor and apply/capture its mutation under the existing view write exclusion, so snapshots cannot claim unfinished coverage. Keep native RPCs outside it. Use captured-read and projection revisions to fence stale overlap rows, turns and lifecycle; optional native turn-start timestamps are not snapshot versions. Current native reads govern their returned turns; retained cached turns cannot borrow an unrelated page's freshness.
- Editable panes load/refill through the canonical attach response, using native resume initial pages. Do not restore a separate attach effect, loaded-thread probe, disposition DTO or prose-based snapshot retry loop. Read-only observers use history reads without activation. Active native resumes reconstruct temporary item IDs; read persisted native IDs with the additional page instead of building alias state or collapsing rows by text/client ID. Native full-item page limits bound turns, not items.
- Native `thread/reverted` resets the canonical history/live projection and its cursors. Capture history-read and pending-input submission revisions before native calls; reject pre-reset history replies and suppress only the obsolete projection of accepted input. Do not convert a successful native input acknowledgment into a retryable failure. Browser snapshot/older-page/observer reads must be canceled or ignored at canonical invalidation. Apply full snapshots before a following refill marker can discard batched events. Deliver refill signals independently of transcript high-water filtering without rewinding the cursor; the marker itself supplies no transcript rows. Revert affects conversation history, not files, unsent drafts or independent app artifacts.
- Visible thread timeline rendering must consume gateway canonical thread view snapshots, `thread_view.patch`, and canonical text-only `thread_view.item_delta` events only. Do not render app-server item/turn lifecycle directly from raw SSE events such as `timeline.item_delta`, and do not reintroduce persisted timeline replay as browser transcript history.
- `thread_view.refresh_required` is a refetch signal, not a timeline row source. Browser reducers may advance cursors from it, but must converge by reading the gateway thread detail snapshot.
- Browser read/unread projections merge the entire native-ID read tuple by `readRevision`, including newer null/unknown state. Seen writes name the exact foreground canonical completion and revision; unknown heads or stale acknowledgments cannot consume later work. Do not infer completions from idle patches or preserve old maxima/sticky flags. Native completion order comes from a bounded descending header page, never UUIDs/timestamps or a history count scan.
- Terminal ingestion keeps only one unconfirmed live completion witness and invalidates the durable head before reconciliation. Do not issue a native completion/history reconciliation RPC inside serial notification ingestion; bounded native reads confirm and clear the matching witness outside that transport. Conditional invalidation of already-unknown state is a no-op, preventing refill loops; completion/revert event invalidation always fences in-flight reads.
- App badges use the complete eligible native inventory, independent of sidebar pagination, with bounded head-query concurrency and a catalog membership fence. Unknown or failed inventory/head reads preserve the previous badge. Push display remains independent of unread count, including zero, and the worker refetches authoritative badge state rather than applying delayed push counts.
- Push previews must read native metadata and a bounded item page for the delivery's exact turn. Do not hydrate full transcript history, substitute a newer turn's answer or treat native/schema failures as empty history. Generic notification text is sufficient when that turn has no retained preview. Keep Push eligibility independent of read receipts and unread badge counts.
- Selected-thread Stop must route through `POST /v1/threads/{threadId}/interrupt-current`; the browser must not choose the interrupted turn from local `activeTurnId` except for explicit turn-id API utilities.
- Ordinary Send delegates to native atomic start-or-steer; do not rebuild cached start/steer routing, generic automatic input-write retries or unsupported-steer queue fallback. Generate one client-message ID per explicit attempt and preserve it unchanged through native submission, canonical snapshots and live projections. Match synthetic pending rows by turn/client identity and browser optimistic rows by submitted identity; canonical native item IDs remain distinct even when client IDs repeat. Client IDs are correlation, not an idempotency or committed-delivery guarantee.
- Normal browser Send and Queue submit input and attachments without replaying model, effort, service-tier or permission defaults. Existing-chat pickers send only explicit changed fields to native thread settings. The native settings update acknowledgment means queued, not applied; applied notifications and reconnects trigger authoritative refills. Draft choices are native creation data; do not add a gateway settings table, pane overlay or revision to preserve old semantics. Explicit per-turn API overrides remain submission data.
- Keep guardrail tests updated when changing lifecycle event names. A behavior change that adds a new browser-visible lifecycle event should fail loudly unless the canonical source-of-truth contract is updated in code and docs.
- Native approvals are connection-scoped in-memory projections; only generated-app grants belong in durable approval storage. Browser approval state comes from full runtime/revision snapshots; `approval.changed` invalidates that snapshot, including lag markers at an existing cursor. Do not restore native rows from event replay, infer resolution from response-write success, or revive non-actionable requests after an ambiguous write failure.
- Thread/session settings that affect future turns must use native partial-update/version semantics or gateway coordination where the native contract requires it. A stale tab must not be able to silently overwrite newer shared settings by submitting a full local options object.
- Native config forms must capture the displayed native write target/version when opened. Submit sparse native edits with that version; never fetch a fresh version to authorize a stale draft. On conflict, preserve the draft and require explicit review before another submission. Do not reconstruct MCP server objects or return raw native config layers/secrets. `config.changed` is a refill marker for saved writes; publish it even when a subsequent MCP reload request fails. Reload acknowledgment means requested, not ready.
- Any behavior-changing feature that touches shared thread/project/session state should include a same-user, two-tab test shape: one client mutates or misses events, and the other must converge through gateway state/SSE without reload.

## Parallel Work

- Use GPT-6.1 Sol with high reasoning for future subagent spawns, as requested by the user.
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

- Native app-server redesign: [plans/native-app-server-redesign.md](plans/native-app-server-redesign.md)
- Backend MVP: [plans/mvp-backend.md](plans/mvp-backend.md)
- Frontend MVP: [plans/mvp-frontend.md](plans/mvp-frontend.md)
- Future extensions: [plans/future-extensions.md](plans/future-extensions.md)

## Initial Architecture Constraints

- Monorepo from scratch.
- Backend stack: Rust, `axum`, `tokio`, `sqlx`, SQLite WAL.
- Frontend stack: React, Vite, TypeScript.
- API contract stack: Rust DTOs plus generated OpenAPI, with frontend-generated TypeScript types/client.
- Gateway talks to a configured external `codex` binary over stdio.
- Architecture target: every Kodex-launched Codex process uses a dedicated, real Kodex `CODEX_HOME`, separate from Codex desktop. Shared desktop homes and shared desktop runtimes are outside the target. Dedicated fresh startup and personal-account sign-in/restart are validated. Organization-managed storage confinement remains unsupported; see the [native app-server redesign plan](plans/native-app-server-redesign.md) and its supporting audit for validation requirements.
- The native-first redesign starts with fresh Codex and gateway state. Do not build legacy data imports, old-to-new ID mappings, queued-work conversion, or compatibility readers. Leave old storage intact and keep it out of the new runtime; fresh initialization does not require migrating existing user data.
- Use native queue restart semantics in the redesign: ordinary queued work waits until its chat is loaded after app-server restart. Do not add a general startup activation index or restore the old drainer. Retained automations may activate their own targets using their schedule/run records.
- Retain automations, MCP Apps, MCP setup, Kodex Control tools, docking, PWA extras, queued-message steering, and the integrated terminal with gateway-owned process supervision independent of app-server. Simplify their implementations around native primitives while preserving their intended workflows. Remove remote development-server previews and their preview-specific control surface; file previews and generated app surfaces remain distinct retained features. Remove automatic title generation in favor of native preview text and manual names. These are target-scope decisions, not claims that the redesign is implemented.
- New browser project creation selects one directory within the gateway home and derives its name. New project chats and project terminals execute in the sole project root; do not restore a draft working-directory override. Existing chats keep their native cwd. Do not expose moving existing chats between projects or clearing their project assignment; project deletion and external native membership changes still converge through native reads. Native zero/multiple-root projects must be corrected before project execution.
- Gateway serves the built frontend in production.
- SSE is the first event transport.
- WebSocket is deferred until a feature requires bidirectional browser transport.
- MVP gateway auth is omitted because deployment is localhost or trusted VPN only.
- ChatGPT/Codex auth is handled through app-server account APIs.

- Browser API compatibility: bump `ApiVersion` in `apps/gateway/src/api_compatibility.rs` on incompatible API changes, regenerate OpenAPI types, and update the frontend epoch to satisfy the generated type. Versioned stale writes are rejected by middleware; unversioned CLI/Control callers remain supported.
