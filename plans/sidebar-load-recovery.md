# Sidebar load recovery

## Status

Active: implementation and review complete; production deployment verification pending.

## Problem and change

Adding a native chat section can trigger overlapping sidebar refills. A canceled SQLx custom `BEGIN IMMEDIATE` can leave a pooled connection inside a transaction before its transaction guard is constructed. This blocks later gateway read-state writes and makes sidebar loads fail even though native project and section records remain intact.

Reject unsafe SQLite connections when they return to the pool, after flushing normal queued rollbacks. Preserve normal connection reuse; do not add request retries, a second native-state store, or direct database repairs. Cover cancellation and independent-writer progress with a file-backed regression.

The sidebar must visibly report load/refill failures and offer explicit Retry while retaining any previously successful snapshot. Cover initial failure and second-client recovery after missed section updates.

Remove the redundant project editor Move before/Move project form. Keep native sidebar drag ordering and its regression coverage.

## Validation

Backend cancellation/concurrency tests and relevant suite; frontend error/retry and existing snapshot preservation; browser native project drag and section convergence; production build, trims and independent review. Deploy via the macOS service updater, then verify live sidebar reads include the existing project and section.

Validation passed: full gateway suite (608 library tests, one intentionally ignored helper), ten repeated cancellation regressions, backend trim; 859 frontend tests, frontend build and trim; four native-project browser flows and three desktop/narrow-fine/narrow-touch sidebar recovery flows. Independent review found no blockers.
