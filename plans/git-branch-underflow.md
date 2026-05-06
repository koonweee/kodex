# Git Branch Underflow Plan

## Status

Complete

## Goal

Show the current Git branch for the selected thread in the Kodex web composer underflow, matching Codex TUI's omission-first behavior: display branch metadata when it is available, and hide it when unavailable.

## Acceptance Criteria

- Existing thread responses expose typed `gitInfo.branch` through the gateway and generated OpenAPI frontend types.
- App-server thread metadata updates carrying `gitInfo.branch` update the frontend thread cache through the existing `timeline.thread_metadata` path.
- The composer underflow renders the selected thread branch with a Git tree icon and truncates long branch names.
- Draft project composer underflow still shows the project name with the folder icon.
- Missing, null, or empty branch metadata renders no branch placeholder or warning.
- Focused backend and frontend tests pass, generated frontend API types are updated, and the implementation passes an independent review loop.

## Source Of Truth

- App-server thread schemas in `apps/gateway/app-server-schema/0.128.0/json/v2/*` define `gitInfo.branch`.
- Upstream Codex TUI treats branch as best-effort status metadata: resolve branch for the current cwd, cache by cwd, omit unavailable values, and refresh after turns complete or are interrupted.

## Implementation Steps

1. Gateway DTOs
   - Add a typed `GitInfo` DTO to `ThreadSummary`.
   - Parse `gitInfo` from app-server thread list/read/command payloads.
   - Parse `gitInfo` from live thread metadata events.

2. Frontend Data Flow
   - Regenerate `apps/web/src/api/generated/schema.ts`.
   - Pass `selectedThread.gitInfo.branch` from `App` into `ComposerPanel`.

3. Composer UI
   - Generalize composer underflow rendering so it can show draft project context, selected branch context, or both as needed.
   - Use a lucide Git tree-style icon for the branch row.
   - Keep existing CSS truncation and add a full-value hover title.

4. Tests
   - Add backend normalization coverage for `gitInfo.branch`.
   - Add frontend component coverage for branch underflow rendering and absence when unavailable.
   - Add app-level coverage that a live thread metadata update changes the displayed branch.

5. Verification
   - Run focused Rust tests for app-server/event normalization.
   - Run focused Vitest tests for composer/App behavior.
   - Run frontend build or typecheck if generated API types changed.
   - Run independent review and fix loop until no major issues remain.
