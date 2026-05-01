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
| [MVP frontend implementation plan](mvp-frontend.md) | Proposed | React web client for projects, threads, timeline, composer, approvals, account/models | Depends on generated OpenAPI types or gateway mocks generated from the same contract. |
| [Future extensions overview](future-extensions.md) | Proposed | Non-MVP feature map linked to app-server APIs | Overview only, not an implementation plan. |

## Maintenance Rules

- Every plan status change must update this table.
- Every implemented milestone must update `README.md` if commands, behavior, or setup changed.
- Every workflow or convention change must update `AGENTS.md`.
- Public API contract changes must be reflected in backend DTOs and regenerated OpenAPI artifacts.
- New plans must be added here before implementation starts.
