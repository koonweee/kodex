# Plans Index

This file is the directory of record for Kodex plans. Keep the status column current whenever work starts, completes, pauses, or changes scope.

## Status Values

- `Proposed`: plan exists but implementation has not started.
- `Active`: implementation is currently underway.
- `Blocked`: implementation cannot proceed without a decision or dependency.
- `Complete`: planned scope is implemented and documented.
- `Superseded`: plan was replaced by another plan.

## Plan Directory

| Plan | Status | Scope | Notes |
| --- | --- | --- | --- |
| [MVP backend implementation plan](mvp-backend.md) | Complete | Rust gateway, app-server supervisor, event store, API, approvals, account/models | MVP backend milestones are implemented, covered by gateway tests, and pushed. |
| [MVP backend revision 1 plan](mvp-backend-rev-1.md) | Complete | Backend ownership cleanup before frontend implementation | Added app-server adapter ownership, typed frontend-critical response DTOs, event/static modules, and contract tests. |
| [MVP frontend implementation plan](mvp-frontend.md) | Complete | React web client for projects, threads, timeline, composer, approvals, account/models | MVP frontend milestones are implemented with Vitest and Playwright coverage. |
| [Timeline UI polish plan](timeline-ui-polish.md) | Complete | Codex app-server timeline rendering, event filtering, turn grouping, rich tool renderers, debug mode | Implemented chat-first timeline presentation, debug mode, fixed thread header, and compact tool renderers. |
| [Timeline performance plan](timeline-performance.md) | Complete | Timeline derivation, memoization, streaming batching, reducer storage, and dynamic-height virtualization | Implemented timeline derivation, approval indexing, memoized rows and markdown, batched streaming updates, optimized reducer storage, and dynamic-height virtualization. |
| [Composer cleanup plan](composer-cleanup.md) | Complete | Unified composer send/stop behavior and queued steer rows | Implemented unified send/stop composer behavior, queued steer rows, keyboard submit handling, and responsive card styling. |
| [Image attachments plan](image-attachments.md) | Complete | End-to-end image attachments from web composer through gateway to app-server | Implemented typed image inputs, local image uploads, composer attachment UX, drag/drop, and timeline thumbnails. |
| [App-server thread item coverage plan](app-server-thread-items.md) | Complete | Web timeline support for all pinned Codex app-server ThreadItem variants | Implemented hidden fallback for unknown items plus first-class rendering for collaboration, review, plan, compaction, and image-related items. |
| [Optimistic user messages plan](optimistic-user-messages.md) | Complete | Immediate user-message rendering with app-server reconciliation | Implemented optimistic text, image, draft-thread, and queued-steer sends with reconciliation and retry-safe failure handling. |
| [Composer footer controls plan](composer-footer-controls.md) | Complete | Codex-style composer controls for model, reasoning effort, fast mode, permissions presets, and context usage | Implemented composer controls, request forwarding, generated OpenAPI/frontend types, and context usage display. |
| [Composer toolbar persistence plan](composer-toolbar-persistence.md) | Complete | App-server-backed persistence for composer model, reasoning effort, and Fast mode | Implemented app-server config read/write routes, generated frontend types, startup hydration, thread-state reconciliation, and persist-on-selection UX without browser storage. |
| [Skill shortcut composer plan](skill-shortcut-composer.md) | Complete | `$` skill autocomplete, gateway-owned skill catalog resolution, and app-server refresh lifecycle | Implemented frontend autocomplete, gateway canonical resolution, skill invalidation, generated API types, and verification coverage. |
| [Inline skill badges plan](inline-skill-badges.md) | Complete | Gateway-normalized inline skill badges for user-authored timeline messages | Implemented structured `text_elements`, gateway-normalized `skillMentions`, optimistic parity, and inline timeline badges without `$` string scanning for rendering. |
| [Skill badge catalog enrichment plan](skill-badge-catalog-enrichment.md) | Proposed | Catalog-backed display name, short description, brand color, and icon enrichment for inline skill badges | Follow-up to inline skill badges; preserves `$name`/path identity and falls back cleanly on catalog misses. |
| [Frontend ownership refactor plan](frontend-ownership-refactor.md) | Complete | React module ownership, large-file cleanup, and frontend contributor guardrails | Split shell, timeline, composer, approvals, tests, and styles into clearer ownership boundaries and added frontend guardrails. |
| [Thread open performance plan](thread-open-performance.md) | Complete | Frontend thread selection jank, sidebar render isolation, and initial timeline measurement readiness | Implemented sidebar render isolation, stable shell callbacks, and stricter initial timeline readiness; verified with tests, build, and long-thread benchmark repeats. |
| [App-server read-through thread sync plan](app-server-read-through-sync.md) | Complete | App-server-canonical thread history, gateway reconciliation, unified timeline updates, and experimental schema hard cut | Implemented experimental schema generation, required extended app-server history, app-server snapshot thread detail, snapshot-first frontend timeline loading, and snapshot refresh over the selected-thread SSE stream. |
| [Timeline replay removal plan](timeline-replay-removal.md) | Complete | Remove persisted timeline event replay from canonical thread loading and recovery | Implemented snapshot-first selected-thread loading, operational-only `/v1/events`, diagnostic raw replay at `/v1/debug/events`, and snapshot refresh on stream uncertainty. |
| [Chat render order and subscription parity plan](chat-render-order-subscription.md) | Complete | Stable timeline item ordering and selected active-thread live attach parity with Codex TUI | Implemented stable lower-seq live merges, active-thread attach behavior, reconnect stability, and agent-browser H1-H4 verification. |
| [Sidebar ordering plan](sidebar-ordering.md) | Complete | Stable project ordering, manual project reorder, and attention-first thread ordering | Implemented persisted project drag order, newest-created defaults, and attention-first thread sorting. |
| [UI standardization plan](ui-standardization.md) | Complete | Shared frontend UI tokens, menu/button/selectable primitives, semantic tones, surfaces, responsive QA | Implemented shared tokens, menu/selectable/button/tone styling, responsive fixes, agent-browser pass, and review-fix loop. |
| [Gateway queue persistence plan](gateway-queue-persistence.md) | Complete | Gateway-owned persistent per-thread composer queue for same-gateway multi-client use | Implemented queued-input API, SQLite persistence, drainer, frontend migration, generated OpenAPI types, and automated verification; desktop/iPad agent-browser scenarios remain as manual smoke coverage. |
| [Gateway pending steer commit plan](gateway-pending-steer-commit.md) | Complete | Gateway-owned pending-commit lifecycle for active-turn steers before app-server user-message commitment | Adds `pendingCommit` queue state, FIFO committed-message reconciliation, and multi-client-safe steer visibility. |
| [Chat sidebar plan](chat-sidebar.md) | Complete | First-class chat threads with gateway-owned dated cwd creation plus sidebar project/chats polish | Implemented Add project copy/icon, subtle project styling, flat Chats list, chat cwd slugging, backend chat endpoints, generated frontend types, and verification. |
| [Server-owned thread settings plan](server-owned-thread-settings.md) | Complete | TUI-aligned local-only drafts plus gateway/app-server ownership for existing-thread model, reasoning, speed, permissions, sandbox, and cwd settings | Implemented gateway create-response setting overlays, removed existing-thread client settings cache, added fresh-render coverage, and verified with backend/frontend focused tests plus review-fix loop. |
| [Git branch underflow plan](git-branch-underflow.md) | Complete | Selected-thread Git branch metadata in the composer underflow | Implemented typed app-server `gitInfo.branch` flow, composer underflow rendering, focused tests, review loop, and agent-browser smoke coverage. |
| [File preview serving plan](file-preview-serving.md) | Complete | Gateway-served previews for app-server generated images, image views, Markdown files, and future supported file content | Implemented thread-scoped `/files/preview` serving with image and Markdown support first; initial endpoint intentionally trusts localhost/VPN deployment instead of root-scoping paths. |
| [Timeline rendering feedback fixes plan](timeline-rendering-feedback-fixes.md) | Complete | File-change diff viewing, failed command status, and local Markdown side-pane preview | Excludes native plan rendering and fixture/dev QA pages by request. |
| [Collaboration agent timeline rendering plan](collab-agent-timeline-rendering.md) | Complete | Friendly subagent names, structured collab activity rows, Markdown result previews, and Codex TUI parity cues | Frontend-only timeline rendering implemented with raw IDs limited to debug payloads. |
| [Pinned threads plan](pinned-threads.md) | Complete | Gateway-owned pinned thread state, pin/unpin API, Pinned sidebar section, and responsive pin controls | Implemented durable gateway SQLite pin state, pin/unpin and pinned-list routes, generated frontend API types, SSE updates, sidebar pin controls, and focused verification. |
| [Deep link navigation plan](deep-link-navigation.md) | Complete | URL-owned thread selection, empty default pane, mobile Back to thread selector, and desktop Back/Forward selection | Implemented URL-owned selection, empty default pane, mobile Back to selector, not-found pane, and SPA fallback verification. |
| [Sidebar row primitives plan](sidebar-row-primitives.md) | Complete | Shared sidebar row layout primitives for section, project, and thread row alignment | Implemented shared section/project/thread rows, collapsible Pinned, fixed rails, and mobile touch/hover validation. |
| [Gateway automations plan](automations.md) | Complete | Gateway-owned recurring prompts into target threads using queued-input execution | Implemented scheduler, source-labeled queue rows, automation API/OpenAPI, generated frontend types, and backend verification; no frontend UI in v1. |
| [Future extensions overview](future-extensions.md) | Proposed | Non-MVP feature map linked to app-server APIs | Overview only, not an implementation plan. |

## Maintenance Rules

- Every plan status change must update this table.
- Every implemented milestone must update `README.md` if commands, behavior, or setup changed.
- Every workflow or convention change must update `AGENTS.md`.
- Public API contract changes must be reflected in backend DTOs and regenerated OpenAPI artifacts.
- New plans must be added here before implementation starts.
