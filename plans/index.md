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
| [Future extensions overview](future-extensions.md) | Proposed | Non-MVP feature map linked to app-server APIs | Overview only, not an implementation plan. |

## Maintenance Rules

- Every plan status change must update this table.
- Every implemented milestone must update `README.md` if commands, behavior, or setup changed.
- Every workflow or convention change must update `AGENTS.md`.
- Public API contract changes must be reflected in backend DTOs and regenerated OpenAPI artifacts.
- New plans must be added here before implementation starts.
