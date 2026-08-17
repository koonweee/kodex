# Sidebar Payload Trimming Plan

## Status

Complete.

## Context

Fresh production-bundle profiling on May 19, 2026 showed that the current web startup path is still dominated by sidebar list payloads, even after the completed [sidebar thread list performance plan](sidebar-thread-list-performance.md):

- `GET /v1/sidebar/threads` took about 2.47s and transferred about 659 KB before the sidebar was ready.
- One large project contributed about 316 KB for 100 initial rows, and another contributed about 193 KB for 57 rows.
- The frontend initially renders only five rows per thread section, but the gateway still fetches `DEFAULT_THREAD_LIST_LIMIT = 100` for every project and for chats.
- `ThreadListResponse.rawPayload` duplicates the upstream list payload, and each `ThreadSummary.rawPayload` duplicates the upstream raw thread object.

The highest-value first optimization is to make the sidebar startup snapshot compact while preserving existing scoped list routes, cursor-backed show-more behavior, and gateway-owned multi-client state convergence.

Relevant seams:

- `apps/gateway/src/routes/threads.rs`
  - `DEFAULT_THREAD_LIST_LIMIT`
  - `get_sidebar_threads`
  - `list_project_threads_for_cwd`
  - `chat_thread_list_response`
  - `pinned_thread_list_response`
  - `apply_thread_list_response_state`
  - `sync_thread_list_raw_payload`
- `apps/gateway/src/app_server_api.rs`
  - `ThreadListResponse`
  - `ThreadSummary`
  - `ThreadSummary::from_payload`
- `apps/web/src/threads/WorkspaceSidebar.tsx`
  - `VISIBLE_THREAD_LIMIT`
  - `ThreadList`
  - section-level `hasMore` and `paginationState`
- `apps/web/src/threads/useSidebarThreadsSnapshot.ts`
  - startup snapshot hydration into TanStack Query caches
- `apps/web/src/threads/cache.ts`
  - merge-protected sidebar cache helpers
- `apps/web/src/api/client.ts` and `apps/web/src/api/generated/schema.ts`
  - generated OpenAPI-backed response types
- `apps/web/src/composer/settings.ts`
  - current fallback reads from `thread.rawPayload` when top-level settings are absent

## Current State

- `/v1/sidebar/threads` exists and removes the old browser-side startup fan-out, but it still calls `list_project_threads_for_cwd(..., Some(DEFAULT_THREAD_LIST_LIMIT))` for every project and `chat_thread_list_response(..., Some(DEFAULT_THREAD_LIST_LIMIT))`.
- `DEFAULT_THREAD_LIST_LIMIT` is currently 100, while `WorkspaceSidebar` only shows `VISIBLE_THREAD_LIMIT = 5` rows before "Show more".
- The frontend already tracks `nextCursor` for project and chat sections and can use scoped list routes to append more rows after startup.
- Thread list and detail DTOs still expose `rawPayload` publicly. That is convenient for debug and app-server parity, but it inflates hot-path payloads.
- The frontend has typed top-level `ThreadSummary` fields for composer settings (`model`, `reasoningEffort`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, `sandbox`), but `composer/settings.ts` still uses `rawPayload` as a fallback.
- `AGENTS.md` requires public API changes to flow through Rust DTOs, generated `/openapi.json`, and generated frontend TypeScript types.

## Non-Goals

- Do not replace the selected-thread timeline contract or add partial timeline history loading in this plan.
- Do not remove scoped `/v1/threads`, `/v1/chats/threads`, or `/v1/threads/pinned` routes.
- Do not change sidebar ordering, pinned semantics, archive behavior, unread state, or thread lifecycle ownership.
- Do not make browser-local state authoritative for sidebar correctness.

## Milestones

### 1. Reduce Sidebar Startup Page Size

Scope: `apps/gateway/src/routes/threads.rs`, route tests in `apps/gateway/src/routes/mod.rs`, and the existing frontend sidebar pagination tests.

Work:

- Add a sidebar-specific initial limit, for example `SIDEBAR_INITIAL_THREAD_LIST_LIMIT`, instead of using `DEFAULT_THREAD_LIST_LIMIT` in `get_sidebar_threads`.
- Set the first implementation to a conservative value tied to the UI, preferably `VISIBLE_THREAD_LIMIT + 1` mirrored as a backend constant with an explanatory comment, or `10` if tests show the extra buffer helps reduce show-more fetch churn.
- Use the new limit for project thread groups and chat threads in `/v1/sidebar/threads`.
- Preserve `nextCursor` and `backwardsCursor` in every sidebar group so "Show more" can fetch additional rows through the existing scoped endpoints.
- Keep pinned threads unchanged in this milestone unless tests show pinned contributes material startup cost in the current database.

Exit criteria:

- Backend tests prove `/v1/sidebar/threads` calls project and chat list paths with the new sidebar initial limit rather than 100.
- Backend tests prove a busy project returns `nextCursor` when more rows exist.
- Existing frontend show-more tests still prove project and chat sections append next pages when a cursor exists.
- `cargo fmt` and focused gateway route tests pass.

### 2. Add Compact Sidebar DTOs Without Raw List Payloads

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, generated OpenAPI, `apps/web/src/api/client.ts`, `apps/web/src/threads/useSidebarThreadsSnapshot.ts`, and `apps/web/src/test/mvpAppHarness.tsx`.

Work:

- Introduce sidebar-specific response DTOs for `/v1/sidebar/threads`, for example:
  - `SidebarThreadsResponse`
  - `SidebarThreadListResponse`
  - `SidebarThreadSummary`
- Omit `ThreadListResponse.rawPayload` from sidebar groups.
- Prefer omitting per-thread `rawPayload` from `SidebarThreadSummary`; if that is too large for one pass, serialize `rawPayload` as `{}` only on the sidebar endpoint and keep the typed top-level fields complete.
- Keep full `ThreadListResponse` and `ThreadSummary` unchanged for compatibility on scoped list, command, and detail routes unless a follow-up explicitly removes raw payloads everywhere.
- Add conversion helpers from `ThreadSummary` to `SidebarThreadSummary` after gateway overlays are applied, so pin state, read state, composer settings, git info, preview, and status remain typed.
- Regenerate OpenAPI and frontend schema after the DTO change.
- In the frontend, hydrate existing sidebar caches from compact sidebar summaries. If caches still use `ThreadSummary`, add a narrow adapter that fills `rawPayload: {}` and document that sidebar consumers must use typed fields.

Exit criteria:

- Backend serialization tests prove `/v1/sidebar/threads` no longer includes duplicated list `rawPayload.data`.
- Backend tests prove compact sidebar summaries retain fields required by `WorkspaceSidebar`, composer controls, unread markers, pin controls, and project/chat classification.
- Frontend tests prove startup snapshot hydration still populates project, chat, and pinned caches and does not require raw thread payloads.
- `cd apps/web && npm run generate:api` updates `apps/web/src/api/generated/schema.ts`.

### 3. Remove Frontend Sidebar Dependence On Thread Raw Payload

Scope: `apps/web/src/composer/settings.ts`, sidebar cache tests, composer settings tests, and any type adapters introduced in Milestone 2.

Work:

- Update `settingsFromThread` in `apps/web/src/composer/settings.ts` so the primary contract is typed top-level `ThreadSummary` fields, not `thread.rawPayload`.
- Keep a compatibility fallback for command/detail/list routes that still include raw payloads, but add tests proving sidebar-created compact summaries are sufficient.
- Audit production frontend code for remaining `ThreadSummary.rawPayload` reads outside tests and debug-only paths.
- If remaining reads exist, either migrate them to typed fields or explicitly keep them out of the sidebar startup path.

Exit criteria:

- Focused composer settings tests pass with thread summaries whose `rawPayload` is omitted or `{}`.
- A static search shows no startup/sidebar code path depends on raw thread payload contents.
- Existing create, resume, selection, and composer setting overlay tests still pass.

### 4. Profile And Set A Payload Budget

Scope: profiling scripts/artifacts under `/private/tmp`, no committed generated profile output unless explicitly requested.

Work:

- Re-run the same production-bundle happy-path profile against `http://127.0.0.1:8787` after Milestones 1-3.
- Capture at least:
  - app load to sidebar ready,
  - normal Kodex thread selection,
  - composer local interaction,
  - large thread selection,
  - large-thread scroll.
- Compare `/v1/sidebar/threads` against the May 19, 2026 baseline: about 2.47s and 659 KB.
- Add a practical target budget to this plan after implementation, such as sidebar snapshot under 150 KB on the current local database, if the achieved result supports it.

Exit criteria:

- `$agent-browser` or Playwright profile confirms `/v1/sidebar/threads` transfers materially less data and still renders the same visible first rows.
- Browser validation confirms "Show more" fetches additional rows for the `kodex` project without duplicate rows or lost selection.
- No long tasks or obvious render regressions appear in the happy-path profile.

## Verification

- `cargo fmt`
- Focused gateway tests for `/v1/sidebar/threads`, compact serialization, list cursors, and overlay preservation.
- `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/threads/cache.test.ts src/threads/WorkspaceSidebar.reorder.test.tsx src/App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm run build`
- Regenerate and verify OpenAPI/frontend types when DTOs change:
  - inspect `GET /openapi.json`
  - `cd apps/web && npm run generate:api`
- `$agent-browser` or Playwright production-bundle profile comparing `/v1/sidebar/threads` size and load time to the May 19, 2026 baseline.

## Implementation Notes

- The first implementation pass set the sidebar startup page size to 10 rows per project/chat section.
- `/v1/sidebar/threads` now returns compact sidebar-specific thread summaries and no longer includes duplicated list or per-thread raw payloads.
- The frontend adapts compact sidebar summaries into existing query-cache `ThreadSummary` projections with `rawPayload: {}` while sidebar consumers use typed fields.
- `composerSettingsFromThread` now accepts summaries without raw payload fields and only keeps raw payload as compatibility fallback for older/full response shapes.

## Profiling Result

Production-bundle profiling against a temporary updated gateway on `http://127.0.0.1:8790` produced:

- Profile artifact: `/private/tmp/kodex-web-profile-2026-05-19T11-28-40-323Z/profile-summary.json`
- `/v1/sidebar/threads`: about 1.44s and 38.6 KB, down from the May 19 baseline of about 2.47s and 659 KB.
- Practical local payload budget: keep `/v1/sidebar/threads` under 50 KB on the current local database shape; revisit if pinned rows or project counts grow substantially.
- Large-thread scroll generated no network requests in the profiled flow.
- Show More validation artifact: `/private/tmp/kodex-showmore-2026-05-19T11-37-09-321Z/show-more-summary.json`
- Show More validation confirmed the selected thread URL stayed stable, the `kodex` project expanded from 5 to 110 visible rows, and the visible row count matched the unique thread IDs from the first two API pages.

## Risks And Open Questions

- A very small initial limit can cause an immediate "Show more" fetch for users who routinely expand busy projects. Start with `VISIBLE_THREAD_LIMIT + 1` or `10`, then let profiling and UX smoke tests decide whether the buffer should be adjusted.
- Compact sidebar DTOs must not drop gateway-owned state such as unread completed turns, pin state, pending title projections, status, or composer setting overlays.
- Some tests and compatibility routes still expect `rawPayload`. Keep the raw-payload removal scoped to the sidebar endpoint first; broader API cleanup should be a separate plan.
- If pinned threads become large again, add pinned pagination or compact pinned DTOs using the same shape. The first pass can leave pinned unchanged because the current profile showed project and chat groups dominate.
- Timeline detail payload trimming remains valuable, but it should follow this plan because selected-thread history pagination touches the canonical `ThreadViewResponse.timeline` contract and has higher correctness risk.
