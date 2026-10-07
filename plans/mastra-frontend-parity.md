# Main frontend on the Mastra backend

Status: Active. Authorized 2026-10-07. Running log: [Mastra port](mastra-port.md).

## Fixed reference and scope

Initial main reference: `00d22832cb43a2784826b1eb9a25689d4b1e5eba`. Merge this exact commit into `codex/mastra-sdk-spike` once, then use it as the visual and interaction acceptance baseline. Main may advance independently; defer later-main discrepancies to a bounded final comparison. Do not change the main checkout or deploy the production service.

Deliver basically the Kodex frontend from this reference working end-to-end with the new TypeScript/oRPC/Mastra Code SDK backend. Preserve layout, controls, navigation and workflows with very little UI change. Reuse main's actual components rather than a separately reconstructed native shell/pane wherever practical. The extra in-pane thread title is an accidental difference to remove. Unimplemented features are work remaining, not evidence of native incapability.

Native-first concerns ownership, not a license to change the user experience. Mastra owns execution, conversation persistence, tools, memory, goals and scheduling where supported. Kodex supplies product-specific metadata, projections and coordination where needed. Preserve previous decisions: fresh dedicated profile and ChatGPT CLI login; no sandbox; TypeScript/oRPC; no app-server fallback or generic harness adapter; volatile queue loss after restart and native Stop accepted; effectively unlimited goal evaluations; MCP Apps initially deferred; plugins/extensions require their existing isolation assessment. No legacy data migration.

## Decision rule

Proceed autonomously on implementation, routine design choices, tests, fixes, reviews and coherent commits. Stop for user clarification when a genuine Mastra limitation would require changing an existing UI/workflow or another unresolved product tradeoff. Present the exact baseline behavior, native capability/evidence, concrete alternatives and smallest recommendation. Previously accepted differences do not need reapproval. Do not replace unsupported work with successful-looking stubs or silently remove controls. Ordinary WIP errors may remain during development, but do not count as completed parity for in-scope workflows.

## Work sequence

1. Merge the pinned main reference and restore passing builds/tests. Record conflicts/resolutions and verify that main's shared layout is retained.
2. Inventory every browser workflow and backend dependency against the reference. Track each as working, implementing, explicitly deferred/accepted, or awaiting a product decision. Prioritize blockers to normal chat use; do not create a duplicate handwritten wire contract.
3. Port in reviewable slices: native settings/model/auth display and composer; project/chat metadata and sidebar; history/live tools/approvals/questions/queue operations; goals/automations; file previews, terminal and Control; retained PWA/read state/notifications. Refine ordering from the inventory and native capabilities.
4. Reuse established frameworks/native primitives and infer oRPC wire types from the backend. Keep presentation transformations in named modules. Shared state must converge across tabs/reload/reconnect/restart; browser-local drafts and layout remain local.
5. Validate each slice with risk-appropriate failing tests first, real SDK fixtures, independent review and the reference UI/browser flows. Use bundled Chromium for desktop fine pointer, narrow fine pointer and touch as appropriate. Preserve meaningful existing tests; update tests only for explicit accepted semantic differences.
6. At the end, compare later main changes once and reconcile small discrepancies without reopening the entire baseline. Escalate genuinely material new scope rather than silently broadening work.

## Exit conditions

- Main-reference frontend appearance and interactions retained, including no duplicate pane title or replacement shell drift.
- In-scope workflow inventory works against the actual Mastra-backed server; exceptions are explicitly accepted/deferred, not hidden behind unimplemented routes.
- Actual SDK model/tool persistence and lifecycle exercised through the browser; two-client convergence and restart behavior demonstrated for shared mutations.
- Relevant backend/frontend tests, builds, trim and independent reviews pass; setup and running logs current; coherent commits in the separate worktree.
- Final later-main comparison recorded. No production cutover without separate authorization.

## Progress

- Scope and frozen reference recorded before implementation. Initial merge and workflow inventory next.
