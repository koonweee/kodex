# Native goal management

Status: Complete

## Scope

Expose the pinned app-server's thread goal in existing chats, including goals created or updated by the model. Native app-server owns persistence, continuation, budgets and status. The gateway adds typed reads and sparse mutations plus refill notifications, with no goal database or browser continuation loop.

Desktop shows a compact goal bar above the composer. Narrow layouts show an unfilled bullseye beside the model picker, retained for paused, blocked, limited and completed goals. Both open the same management modal with objective, optional token budget, usage, pause/resume, save, a trash icon and close. No explanatory helper text. Existing-chat composer actions offer Set goal when none exists. New-chat goal submission, duration budgets and goal dashboards are outside this slice.

## Correctness

- Read native state when opening a chat; refill on native goal updates/clears, reconnect and foreground recovery. Model-created goals follow this same path.
- Cancel stale overlapping reads before refilling. Markers are operational invalidations, independent of transcript cursors.
- Send only changed objective/budget fields or explicit status actions. Preserve modal drafts through refills and require review of conflicting edits.
- Preserve native omitted/null token-budget semantics. Native activation can start work; do not also send an ordinary turn. Pause and clear do not themselves interrupt the current turn.
- Keep generated Rust/OpenAPI/frontend contracts synchronized.

## Exit conditions

Focused backend/frontend regressions, model-created goal visibility, two-tab mutation and missed-event convergence, desktop/narrow fine-pointer/narrow touch browser validation, build/typecheck, relevant trims, and independent review pass. Deployment is separate.

## Validation

Completed 2026-10-06. The backend suite passed (620 library tests plus binary and integration checks; opt-in runtime checks remain ignored). The full frontend suite passed 926 tests, and the final UI review fixes passed all 27 focused tests. Playwright passed 102 tests with 7 environment-gated skips, including goal management across two tabs, model updates, reconnect recovery and all three viewport/input shapes. Production build, generated API types, backend/frontend trims and independent review passed. The running service was not deployed or restarted.
