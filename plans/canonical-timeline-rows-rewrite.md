# Canonical Timeline Rows Rewrite Plan

## Context

- The current Kodex timeline still feels unpolished around flicker, duplicate file-change blocks, and blank space after file changes.
- The visible symptoms point to split ownership rather than a single bad renderer:
  - `apps/gateway/src/thread_view.rs` owns canonical snapshots and `thread_view.patch` metadata, but still exposes app-server-shaped items.
  - `apps/web/src/timeline/reducer.ts` still applies snapshots, patches, live item deltas, active-turn state, and removal heuristics.
  - `apps/web/src/timeline/derive.ts` rewrites visible items into synthetic activity, file-change, and work rows.
  - `apps/web/src/timeline/renderers.tsx` parses and dedupes file-change payloads after row derivation has already chunked raw file-change items.
  - `apps/web/src/timeline/TimelineView.tsx` expands completed work rows by injecting extra sibling virtual rows outside the `<details>` node that controls expansion.
- The requested direction is a clean rewrite, not a bandaid: assume enough time to enforce strict contracts and reduce future regression risk.

## Current State

- Backend projection:
  - `apps/gateway/src/thread_view.rs::ThreadView` stores normalized `ThreadTimelineSnapshotItem` values by app-server item identity and emits `ThreadViewPatch`.
  - `apps/gateway/src/app_server_api.rs::ThreadTimelineSnapshot::from_turns` flattens app-server turns into item-shaped DTOs with `displayOrder`.
  - `apps/gateway/src/events.rs::timeline_item_delta_event` emits `thread_view.item_delta`; `ThreadViewDeltaBuffer` also buffers deltas before broadcasting.
  - `apps/gateway/src/events.rs::thread_view_patch_event` emits full patch payloads based on the current `ThreadView`.
- Frontend state:
  - `apps/web/src/timeline/reducer.ts` treats `thread_view.patch` as canonical, but also applies `thread_view.item_delta` by constructing assistant rows locally.
  - `removeItemsMissingFromCanonicalPatch` removes active-turn rows omitted from patches, which makes row stability sensitive to patch completeness.
  - `apps/web/src/timeline/batch.ts` applies another client-side coalescing/drop policy for patches and deltas.
  - `apps/web/src/timeline/state.ts` uses mutable map indexes hidden behind immutable-looking state objects; this is efficient but makes ownership harder to audit.
- Frontend row derivation and rendering:
  - `deriveTimelineRows` groups activity rows, file-change rows, and completed work rows after the reducer has produced item-shaped state.
  - `TimelineFileChangesRenderer` dedupes file entries by path inside a rendered chunk, so duplicate control is not part of the canonical data contract.
  - `TimelineWorkRowRenderer` renders only the summary; expanded content is inserted as separate Virtuoso rows by `timelineRenderRows`.
  - Existing regression tests cover file-change chunking and non-overlap, but they preserve the current split derivation model.
- Constraints:
  - App-server remains the durable transcript owner.
  - Gateway owns shared timeline/session/lifecycle state for same-user tabs, reconnects, reloads, and future clients.
  - Frontend API types must come from generated OpenAPI artifacts.
  - Browser-visible lifecycle/timeline changes require same-user two-tab test coverage.
  - UI changes need `$agent-browser` validation across desktop, narrow fine pointer, and narrow touch/mobile when layout/input behavior is affected.

## Target Architecture

- Gateway exposes one renderer-facing row contract. The browser receives rows, not raw items that it must reinterpret into rows.
- App-server raw item payloads may remain attached for debug or renderer leaf content, but identity, ordering, grouping, duplicate suppression, active turn state, work summaries, file-change aggregation, and patch semantics belong to the gateway.
- The frontend timeline reducer becomes a strict canonical store:
  - apply snapshot by replacement,
  - apply `thread_view.patch` by full-row replacement at a newer `viewRevision`,
  - ignore stale revisions,
  - keep only per-tab UI state such as expansion, scroll, focus, drafts, and unsent attachments.
- The frontend renderer becomes a discriminated union renderer over canonical row kinds. It does not derive file-change groups, work rows, row IDs, active-turn status, or duplicate suppression.
- Live streaming can remain incremental, but the gateway emits complete canonical row updates. The browser never reconstructs assistant text correctness from transport deltas.

## Strict Patterns

- One visible timeline contract: `ThreadTimelineSnapshot.rows` and full-row `ThreadViewPatch.rows`.
- One row identity scheme: stable gateway row IDs scoped by thread, turn, item, or canonical group key.
- One file-change aggregator: gateway-only, covered by backend tests.
- One row derivation layer: gateway-only. Delete frontend `deriveTimelineRows` from production rendering.
- One live text accumulator: gateway-only. Retire `thread_view.item_delta` as a visible renderer event or make it private/diagnostic-only.
- No renderer-level duplicate suppression for correctness. Renderer-level filtering is allowed only for cosmetic hiding of empty/debug content and must not change row identity or counts.
- No patch omission heuristics. Patches are complete row views, so removals are represented by the next canonical `rows` replacement.
- No virtual row graph rewrites controlled by local details state unless the child rows are canonical first-class rows with stable IDs.

## Milestones

### 1. Lock The New Contract With Failing Tests

- Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/routes/threads.rs`, `apps/web/src/timeline/reducer.snapshot.test.ts`, `apps/web/src/timeline/TimelineView.render.test.tsx`, and selected app-level two-tab tests.
- Work:
  - Add backend tests for canonical row snapshots containing:
    - user message row,
    - running assistant row,
    - completed work summary row,
    - file-change group row with deduped entries,
    - final assistant row.
  - Add backend tests proving duplicate file-change app-server items for the same path/action collapse into one canonical group entry per turn policy.
  - Add backend tests proving patch rows are complete canonical views, not item-delta or omission heuristics.
  - Add frontend reducer tests proving snapshots replace rows, full-row patches replace rows at newer revisions, and stale revisions are ignored.
  - Add frontend render tests for a growing file-change group followed by a later user message, without depending on switching threads to recover layout.
  - Add a same-user two-tab test shape where one tab misses live events and converges through gateway snapshot/patch state without duplicate file-change or assistant rows.
- Exit criteria:
  - New tests fail against the current item-shaped contract and frontend derivation path.
- Test names describe canonical rows and full replacement patch semantics, not renderer heuristics.

### 2. Define Canonical Timeline Row DTOs

- Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/api.rs`, generated OpenAPI, and frontend generated types.
- Work:
  - Introduce Rust DTOs for renderer-facing rows, for example:
    - `ThreadTimelineRow`,
    - `ThreadTimelineRowKind`,
    - `ThreadTimelineMessageRow`,
    - `ThreadTimelineWorkRow`,
    - `ThreadTimelineActivityGroupRow`,
    - `ThreadTimelineFileChangesRow`,
    - `ThreadTimelineFileChangeEntry`.
  - Keep raw app-server payload data behind an explicit `debugPayload` or item-specific leaf field only where renderers still need content.
  - Add row-level fields required for strict rendering:
    - `id`,
    - `turnId`,
    - `displayOrder`,
    - `status`,
    - `timestampMs`,
    - `revision`,
    - stable child entry IDs where a row contains entries.
  - Change `ThreadTimelineSnapshot` to expose `rows` as the renderer contract. Keep legacy `items` only as debug/transitional data if absolutely necessary, clearly marked not for frontend rendering.
  - Change `ThreadViewPatch` to expose canonical `rows` as a complete replacement view rather than relying on patch item omissions.
  - Regenerate OpenAPI and frontend generated types.
- Exit criteria:
  - `GET /v1/threads/{threadId}` returns canonical rows with generated OpenAPI schema coverage.
- `thread_view.patch` has a single full-row replacement contract.
  - Frontend generated schema includes the row union/DTOs.

### 3. Move Row Derivation Into The Gateway

- Scope: `apps/gateway/src/thread_view.rs` or a new `apps/gateway/src/thread_view_rows.rs`, plus backend tests.
- Work:
  - Build canonical rows from app-server turns and in-memory live state in gateway display order.
  - Move work-summary creation out of `apps/web/src/timeline/derive.ts`.
  - Move activity grouping out of `apps/web/src/timeline/derive.ts`.
  - Move file-change aggregation out of `apps/web/src/timeline/presentationFile.ts` and `apps/web/src/timeline/renderers.tsx` correctness paths.
  - Define a deterministic file-change group policy:
    - group by `threadId + turnId`;
    - dedupe entries by normalized path plus final action category;
    - preserve deterministic path ordering by first display order, then path;
    - combine line counts and modified diffs without duplicating add/delete-only bodies.
  - Preserve final-answer placement and prominent outputs as gateway row ordering decisions.
  - Make app-server materialized rows replace provisional gateway rows by stable identity instead of coexisting.
- Exit criteria:
  - Backend tests prove equivalent snapshots from app-server history and live-notification accumulation.
  - Backend tests prove duplicate file-change blocks cannot be produced for one turn by repeated raw items.
  - `rg "deriveTimelineRows" apps/web/src` finds no production render dependency after frontend migration is complete.

### 4. Consolidate Live Patch And Delta Semantics

- Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/thread_view.rs`, `apps/web/src/timeline/batch.ts`, selected-thread hooks.
- Work:
  - Update inbound app-server notification handling so item deltas update gateway row state first.
  - Emit full canonical row upserts for streaming assistant text, not browser-applied text deltas.
  - Remove or downgrade `thread_view.item_delta` from the visible frontend render contract.
  - Remove duplicate coalescing policies where possible:
    - gateway may throttle/buffer for performance,
    - frontend should only batch React state updates, not decide semantic supersession.
  - Replace `removeItemsMissingFromCanonicalPatch` with canonical row replacement from the patch DTO.
  - Keep `thread_view.refresh_required` as a refetch signal only.
- Exit criteria:
  - A live assistant message streams by repeated row upserts with complete current text.
  - The frontend does not append text deltas for correctness.
  - Backend and frontend tests cover patch replay, stale revision suppression, lag/refetch recovery, and terminal-turn cleanup.

### 5. Replace Frontend Timeline State With A Thin Row Store

- Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/batch.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, and timeline tests.
- Work:
  - Store canonical rows directly as generated API types or a narrow view model derived one-to-one from generated types.
  - Delete production `deriveTimelineRows` usage.
  - Delete frontend row grouping and file-change dedupe from correctness paths.
  - Delete visible `thread_view.item_delta` handling from the reducer.
  - Keep debug warning/error collection isolated from visible timeline ordering.
  - Keep local expansion state keyed by canonical row ID only.
  - Keep browser-local state limited to drafts, unsent attachments, scroll, focus, and expansion.
- Exit criteria:
  - Frontend reducer has small, auditable paths for snapshot replacement, full-row patch replacement, stale revision ignore, and debug-only events.
  - `apps/web/src/timeline/derive.ts` is deleted or moved to tests/fixtures only.
  - `rg "fileChangeEntriesForItems|removeItemsMissingFromCanonicalPatch|thread_view.item_delta" apps/web/src/timeline` shows no production correctness dependency.
  - Focused timeline tests pass.

### 6. Rebuild Timeline Rendering Around Canonical Rows

- Scope: `apps/web/src/timeline/TimelineView.tsx`, `apps/web/src/timeline/renderers.tsx`, `apps/web/src/timeline/FileDiffViewer.tsx`, `apps/web/src/styles/timeline.css`, `apps/web/src/styles/shell.css`, renderer tests.
- Work:
  - Replace item renderers with row renderers keyed by canonical row kind.
  - Render file-change groups from gateway-normalized entries directly.
  - Render completed work rows using one of two strict shapes:
    - a single canonical work row whose expanded body is inside the same virtual item, or
    - gateway-provided first-class child rows with stable IDs and an explicit parent relationship.
  - Choose one shape and encode it as a contract; do not let `TimelineView` invent child rows from a local array.
  - Audit CSS so measured virtual rows do not rely on escaping margins or unbounded internal growth.
  - Keep long diff content horizontally scrollable inside `FileDiffViewer`.
  - Preserve bottom-following semantics with Virtuoso only after the row graph is stable.
- Exit criteria:
  - Expanding file changes or work details does not inject ad hoc synthetic sibling rows.
  - File-change rendering never changes the number of file-change rows by local dedupe.
  - Component tests cover expanded/collapsed work rows, file-change groups, final answer, approvals, and later user messages.

### 7. Remove Compatibility Surfaces And Add Guardrails

- Scope: frontend/backend dead-code removal, guardrail tests, `AGENTS.md` if workflow rules change, and plan index status updates.
- Work:
  - Remove legacy frontend tests that enforce item-shaped derivation behavior.
  - Add guardrail tests that fail if browser-visible lifecycle events bypass canonical rows.
  - Add static checks or focused tests for forbidden production patterns:
    - frontend parsing raw app-server file-change arrays for grouping,
    - frontend deriving work rows,
    - frontend applying item deltas,
    - patch omission removals.
  - Update documentation if contributor workflow or timeline contract rules change.
  - Keep local/VPN-only deployment assumptions unchanged.
- Exit criteria:
  - Guardrails fail loudly if a future change reintroduces client-side row ownership.
  - Documentation and plan status are current.

### 8. Full Verification, Browser Validation, And Review Gate

- Scope: backend, frontend, generated artifacts, browser validation, and independent review.
- Work:
  - Run backend verification:
    - `cargo fmt`
    - `cargo test`
  - Run frontend verification:
    - `cd apps/web && npm test`
    - `cd apps/web && npm run build`
    - `cd apps/web && npm run generate:api` after DTO changes with a gateway running
  - Use `$agent-browser` against the local full-stack app for:
    - long thread with many file changes,
    - duplicate path edits in one turn,
    - live streaming to completed transition,
    - work-row expansion and collapse,
    - desktop fine pointer,
    - narrow fine pointer,
    - narrow touch/mobile,
    - two same-user browser contexts where one misses events and later converges.
  - Run an independent review pass before marking the plan complete.
- Exit criteria:
  - Automated checks pass or unrelated flakes are isolated with focused passing reruns.
  - Browser validation shows no flicker requiring thread switch/reload, no duplicate file-change blocks for the same canonical group, and no blank gap below file-change rows.
  - Review reports no major issues, or all major issues are fixed.

## Verification

- Status: Complete as of implementation review loop. The implementation uses full-row replacement patches rather than incremental `upsertRows/removeRowIds`; this keeps the contract strict and matches the frontend batch strategy that drops superseded patches by revision.
- Backend:
  - `cargo fmt`
  - `cargo test -p kodex-gateway thread_view`
  - `cargo test -p kodex-gateway events`
  - `cargo test`
- Frontend:
  - `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/TimelineView.render.test.tsx src/timeline/renderers.test.tsx`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
  - `cd apps/web && npm run generate:api` after gateway DTO changes
- Browser:
  - `$agent-browser` full-stack validation for the scenarios in Milestone 8.
- Static audit:
  - `rg "deriveTimelineRows|thread_view.item_delta|removeItemsMissingFromCanonicalPatch|fileChangeEntriesForItems" apps/web/src`
  - `rg "timeline\\.item_delta|timeline\\.item_upsert|timeline\\.turn_upsert|timeline\\.thread_status" apps/web/src`

## Risks And Open Questions

- Row DTO design must be discriminated enough for frontend type safety without forcing app-server raw payload interpretation into every renderer.
- Keeping legacy `items` beside new `rows` during the rewrite may reduce migration risk, but it also creates a second contract. Prefer a short hard-cut branch and delete the legacy renderer path before completion.
- If one expanded work row can still become too tall for pleasant virtualization, use gateway-provided canonical child rows with explicit parent/visibility metadata instead of reintroducing frontend derivation.
- Some debug workflows may depend on raw item payload visibility. Preserve this through explicit debug fields or debug routes, not visible timeline ownership.
- OpenAPI generation requires a running gateway. Plan execution should account for that operational dependency when DTOs change.
