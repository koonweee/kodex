# Integration shortcut cleanup

## Status

Active.

## Scope

Resolve all remaining findings in the 2026-10-05 runtime integration audit: versioned browser API compatibility with draft-preserving update notice, one PWA reload owner, checkout-local OpenAPI generation, metadata/bounded native reads for preview and Stop, structured native errors with narrow centralized classifiers, and explicit same-origin PWA support.

Use a protocol epoch rather than forcing updates for every harmless build. Preserve unversioned CLI/Control callers. Already shipped browser bundles cannot acquire new checks without an initial update. Keep workspaces mounted on incompatibility; never automatically reload another tab’s drafts.

## Exit conditions

Focused failing-to-passing regressions, same-user stale/current client coverage, generated contracts, frontend build/trim, backend checks, independent review, and documentation updated. No new durable state, retry subsystem or desktop dependency.

## Validation evidence

- Backend suite: 613 library tests plus four process/integration tests passed; two helper-only tests remain intentionally ignored. All 25 explicit pinned real-native cases passed separately.
- Frontend broad suite: 863 passed initially; two resource-contention timeouts and two tests edited during execution passed in the stable focused rerun (52 cases, including the added Beacon fence).
- Browser suite: 79 passed initially; all four affected cases passed in the stable nine-case rerun, including two-tab compatibility at desktop/narrow widths. Seven opt-in native tests were skipped in the ordinary suite; explicit PWA evidence is recorded separately below.
- Checkout OpenAPI generation, frontend build and both trim checks passed. Independent cross-reviews covered typed errors, bounded native reads, compatibility/draft behavior and PWA ownership.

- Final PWA validation: 63 focused cases and two real built-PWA browser proofs pass, including actual Push/badge behavior and first-install/two-tab update acceptance. The single custom controller handler is retained because the installed library’s callback misses later updates in an initially uncontrolled tab; the library default reload is disabled. Failure cleanup and missed waiting notifications have focused coverage.
