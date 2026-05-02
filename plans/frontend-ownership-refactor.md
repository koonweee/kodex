# Frontend Ownership Refactor Plan

## Summary

Refactor the React frontend in behavior-preserving slices so `App.tsx`, app-level tests, timeline reducer code, and global styles stop accumulating unrelated responsibilities. The shell should coordinate state and data flow while feature modules own rendering, parsing, and focused tests.

## Key Changes

- Keep `App.tsx` as the shell coordinator for project/thread selection, top-level state, and cross-feature wiring.
- Move timeline viewport, bottom-pinned virtualization, and timeline row rendering under `apps/web/src/timeline`.
- Move approval rendering, approval event merging, decision construction, and payload parsing under `apps/web/src/approvals`.
- Move composer attachment, queued steering, and composer settings helpers under `apps/web/src/composer`.
- Move reusable empty-state and primitive shared helpers into small shared modules.
- Split broad app tests and CSS by workflow or feature after module boundaries are stable.

## Test Plan

- Run `cd apps/web && npm test` after each extraction slice.
- Run `cd apps/web && npm run build` after the integrated refactor.
- Run `cd apps/web && npm run test:e2e` before marking the plan complete.
- Use browser automation for happy paths: project creation, draft thread submit, streamed timeline rendering, preferences/theme switching, and approvals when mocked.

## Assumptions

- This is a refactor only; gateway APIs, generated OpenAPI types, and user-visible behavior stay unchanged.
- Existing class names and test selectors remain stable unless a rename is required by extraction.
- Guardrails are documented in `AGENTS.md`; no new lint or boundary tooling is added in this plan.
