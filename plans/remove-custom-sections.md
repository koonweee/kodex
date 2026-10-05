# Remove custom sections

## Status

Complete.

## Scope

Remove custom-section management, generic membership actions, gateway/control APIs, browser caches and obsolete tests. Keep Pinned, Projects and standalone Chats. Expose only pinned-specific client contracts around the native reserved Pinned primitive. Preserve native pin ordering and cross-client convergence without local pin/section tables.

App-server owns native storage: do not directly edit its database or delete chats. Existing custom-section membership must not hide chats from ordinary project/chat lists. Checked-in upstream schemas remain unchanged source material.

## Validation

Cover pin/unpin, ordering, existing custom-membership visibility, absent management routes/tools, and same-user two-tab snapshot/SSE recovery. Regenerate OpenAPI frontend types, run relevant backend/frontend suites, browser flows, builds and trims. Independently review implementation before committing.

After validation, update the installed macOS service and verify existing project/chat visibility and the absence of custom section controls on the private HTTPS site.

Backend validation: five removal/pin/visibility regressions passed after failing against the old contract; 602 library tests and four binary/integration tests passed. Backend trim and a disposable real-native proof passed, including pin order/cursors, history, custom-member visibility and cold restart. Independent backend review found no blockers. Generated OpenAPI types match the final Rust contract.

Frontend validation: 858 tests, production build and trim passed. Independent review covered native pin/refill ownership, ordinary-list overlap filtering, and pagination when the first ordinary page contains only pinned rows. Browser coverage includes desktop, narrow fine pointer and narrow touch, two-tab pin/order/unpin, stale snapshots and actual SSE reconnects.

All 38 affected browser flows passed, including the final reviewed four native-pin flows. Browser fixture review corrected a stale project-creation helper and avoids implying pin/unpin preserves previous custom membership.

Deployed 2026-10-05 using the installed macOS service updater. Live sidebar returns the pinned-only contract and retains `kirbot-pi-rewrite`; the old section route returns 404. Sign-in and private HTTPS remain healthy. Browser update verified Pinned and the existing project/chats visible, no Add section control, and no sidebar error. Existing native custom-section storage was left untouched and is not read or managed by Kodex.
