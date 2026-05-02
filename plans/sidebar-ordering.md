# Sidebar Ordering Plan

## Scope

Make workspace sidebar ordering predictable while still surfacing thread-level work that needs attention.

## Status

Complete

## UX Contract

- Projects are stable navigation anchors.
- Default project order is newest-created first.
- Users can drag projects to define a manual sidebar order.
- Manual project order persists locally across reloads.
- New projects appear at the top until the user manually reorders again.
- Project rows do not move because of thread activity, approvals, or unread state.
- Threads remain a work queue inside each project.
- Threads sort by attention:
  - active/running first
  - needs approval second
  - unread completed agent turn third
  - `updatedAt` descending
  - `createdAt` descending
  - stable title/id fallback
- New materializing threads stay at the top while their title is pending.

## Implementation Notes

- Keep project ordering frontend-owned for now; it is a per-browser layout preference, not a gateway API contract.
- Store only project ids for manual order and merge them with the current project list at render time.
- Keep backend project listing aligned with the default by ordering projects by `created_at desc`.
- Do not add project attention counters or badges as part of this change.

## Exit Conditions

- Focused tests cover default project order, manual project reorder persistence, and new-project placement.
- Focused tests cover thread attention ordering.
- Existing project/thread selection still uses the displayed project and thread order.
- Frontend tests and backend tests pass for touched behavior.

## Completion Notes

- Implemented frontend-owned persisted project ordering with a drag handle.
- Updated default project listing to newest-created first.
- Implemented attention-first thread sorting and initial auto-selection reconciliation after pending approvals load.
- Verified with focused ordering tests, full frontend tests, frontend build, Rust fmt, Rust tests, and Rust clippy.
