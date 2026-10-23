# Inline Generated UI

## Status

Complete. Scoped with the user on 2026-10-22; M1–M4 are implemented, verified and independently reviewed. Deployment and push are outside this plan.

## Objective

Show Kodex-generated interactive HTML as independent cards at their creation points in the chat. Preserve the existing sandbox and gateway-mediated bridge. Keep external MCP Apps in their existing panes.

This plan supersedes generated-provider placement and replacement behavior from the completed [MCP App Surfaces plan](mcp-app-surfaces.md). Its external-provider behavior remains retained.

## User decisions

- Generated UIs only. External MCP Apps continue using panes.
- Every generation creates a new card. A requested revision creates another card in the new response; it never replaces an earlier card.
- Show a card immediately after its creation is accepted, at its originating call position, outside collapsed tool/work details. Do not wait for the final answer.
- Older cards remain interactive. Every explicit conversational submission is a fresh instruction to that thread, even after newer cards appear.
- No expand, separate-pane opening, or collapse control for new generated cards.
- Cards grow with content. Use the chat's vertical scroll, with no host-imposed card height cap or nested document scrollbar.
- Resetting unsent inputs when scrolling unmounts a card is acceptable. No iframe keep-alive or draft persistence is required.
- Retire existing generated panes without importing them into conversation history. Preserve unrelated external MCP panes and stored user data.

## Scope and non-goals

Keep local tabs, filters, sliders and form inputs. Explicit UI actions may invoke the existing granted bridge capabilities, including sending a human-readable user message. Creating a newer card must not invalidate older cards.

No version browser, update-in-place tool for generated cards, expansion, durable form drafts, automatic submission on load, general iframe state serialization, transcript duplication, or native transcript writes to persist HTML. No new automatic retry policy for ambiguous writes.

A small card title and an unobtrusive “Inputs may reset when you scroll away” notice make the lifecycle limitation visible. Use meaningful fallback text for unavailable/retired documents and rendering failures. These are host affordances, not instructions for generated content to implement backend details.

## Evidence from the current checkout

- `apps/gateway/src/store/migrations.rs` makes `app_surface_sessions.thread_id` unique. `store/app_surfaces.rs` updates that single session and rotates its bridge token on every replacement.
- `routes/self_control.rs` and `mcp.rs` expose open/update/latest/presentation behavior for generated surfaces. Both creation and update reach the same upsert.
- Imported MCP apps carry turn/item provenance. Generated calls accept optional source provenance, but the current tool path does not establish a reliable automatic conversation anchor.
- `appSurfaces/AppSurfacePane.tsx` already hosts sandboxed documents and bridges requests. It ignores size-change payloads and recreates the iframe on theme changes.
- `appSurfaces/document.ts` injects theme and bridge helpers with viewport-height minimums suited to panes.
- `panes/appSurface/AppSurfaceWorkspacePane.tsx` fetches only the latest thread session.
- `timeline/TimelineView.tsx` uses Virtuoso; offscreen iframe unmount/reset is expected in this scope.
- `thread_view.rs`, `thread_view_patch.rs`, and generated Rust timeline DTOs own the canonical rendered projection.

## Architecture

### Artifact identity and persistence

Introduce independent, immutable generated artifacts, each with its own ID, document, fallback, grants, provenance, and validated conversation anchor. Creating B leaves A's document and bridge validity unchanged. Mutable operational metadata, such as explicit archival/revocation, is separate from immutable content.

Remove the one-session-per-thread assumption for generated artifacts. Preserve external-provider latest-session semantics explicitly so mixed-provider threads cannot overwrite or select the wrong provider's surface. Choose a scoped schema evolution that preserves existing data; do not reset the instance database or retrofit historical anchors.

Existing generated rows without the new verified anchor are retired: no new inline placement or generated pane rendering, and no active bridge execution. Keep stored rows untouched where possible and distinguish retired state at read/authorization boundaries. Stale browser pane records must resolve to a clear retired state without touching external panes.

### Canonical placement

The gateway owns the artifact-to-conversation association and order. Expose lightweight artifact references through the canonical thread view; fetch HTML only for mounted cards. Do not transmit full HTML in timeline patches or replay it as transcript history.

Anchor to the originating native turn/call using verified transport provenance or an explicit validated contract. Do not infer an anchor from timestamps, browser event arrival, free-form assistant text, or whichever turn happens to be active.

Resolve provenance before accepting a new inline artifact. If no reliable anchor can be established, return an actionable error rather than claiming creation succeeded and silently placing it at the bottom. The first milestone must prove this with the real pinned runtime, including calls through Code Mode.

Artifacts are top-level rows at their origin position. Split surrounding grouped work as needed so later tool activity does not move the card or hide it. Multiple cards from one call use a persisted gateway-owned creation order.

Use existing canonical projection write exclusion/revisions and refill behavior. Native RPCs stay outside the exclusion. Snapshot, live patch, older-page and read-only observer paths must agree; delayed reads cannot resurrect removed placement.

On native revert, remove placements whose anchors leave canonical history and fence in-flight artifact creation/projection against that reset. Do not delete independent artifacts. Reject conversational/tool actions from orphaned or retired placements. Capture the history-reset generation before each native anchor read, fence its response, and carry that token through local validation/approval awaits to a final pre-write check. This check is action admission: reset-first rejects; an action admitted before reset may complete under native semantics. Recheck before a definite missing-thread resume/retry. Never hold projection locks over native RPCs. Forks do not implicitly copy generated artifacts; only the original owning thread gets their placements and bridge authority in this version.

### Bridge and submission

Reuse token validation, sandbox isolation, granted tools/resources, approvals and the existing native input route. Never grant permissions based on iframe messages alone. A new generated card does not rotate another card's token.

Keep older anchored cards usable. Every explicit click is a fresh instruction, using the existing app-surface input policy rather than adopting composer queue routing. Pending feedback is local to that card; do not implement browser-owned “answered” or globally single-use flags. Ambiguous submission failures must not auto-retry.

Read-only observers show fallback content without an executable iframe in this initial version. This avoids presenting controls that imply permission to mutate the thread.

### Rendering and sizing

Extract only the genuinely shared iframe-host logic from pane presentation. External panes keep their sizing and lifecycle; generated cards use content sizing.

Inject measurement for generated documents so agents do not have to implement host sizing themselves. Relay validated size notifications through the existing sandbox proxy and bind them to the current frame/session. Measure after load, content changes, image/font load and width changes; coalesce repeated measurements.

Remove pane-specific viewport minimums from inline document styling. Avoid height feedback loops, repeated reloads, and artificial internal scroll regions. Generated guidance must avoid fixed viewport-height shells. Invalid/non-finite measurements should be rejected without accepting arbitrary CSS or changing surrounding layout authority. No product height cap.

Let Virtuoso measure the resulting row height. Preserve the reader's position when a card above the viewport changes size and preserve existing bottom-follow behavior. Do not steal focus when a card arrives. Width changes reflow within the owning pane, independently of neighboring panes.

The browser regression found that Virtuoso's upward-scroll compensation alone does not preserve a stationary reader after every above-viewport iframe resize. A small per-pane correction therefore captures the visible row before such a resize and restores it through four measurement frames. It uses the existing scroll owner's authoritative bottom-follow state, including a paused reader within the near-bottom band, and cancels on user input. The capture/restore helpers are shared with older-history prepend correction. This is visual state only; it adds no durable state, iframe keep-alive, or retry/synchronization ownership.

Normal virtualization is retained. Remounts may reset unsent local state; reload and theme-related remount persistence are not promised. Avoid rerendering/reloading an unchanged document on routine SSE updates.

## Milestones

### M1 — Prove origin correlation and lock the create-only contract

Native transport evidence: the disposable 0.160.0 Code Mode proof confirms that MCP `_meta.callId` matches the persisted native MCP item ID. `_meta.itemId` instead names the enclosing Code Mode execution and must not be used. Thread/turn identity comes from `_meta["x-codex-turn-metadata"]`; explicit `threadId` still requires gateway ownership and must equal that origin. Concurrent and sequential calls have distinct call IDs. Production acceptance must validate this tuple against the gateway canonical native call, not trust metadata alone. The create-only tool will be `create_app_surface`; generated update and pane presentation operations are removed. External MCP presentation remains available.

1. Inspect the checked-in 0.160.0 schemas and upstream app-server README for call IDs, tool invocation context, and lifecycle. Verify against the actual pinned runtime; do not assume MCP metadata establishes thread ownership.
2. Exercise a generated tool invocation through Code Mode, concurrent calls, multiple creates within a call, and explicit targeting of a different thread. Document the supported origin contract and reject unsupported targeting before persistence.
3. Choose a single create-only generated tool/API contract; remove generated update/show presentation semantics rather than retaining misleading aliases. Keep metadata/document inspection sufficient for generating a revised card.
4. Add failing contract tests for independent creates, immutable content/grants, invalid anchors, and mixed generated/external sessions.

Exit: reliable stable placement is demonstrated without “current active turn” guessing. If the pinned transport cannot support the promised placement, stop and revise this plan with the user; do not silently ship tail placement.

### M2 — Persist independent cards and project canonical rows

1. Implement scoped storage evolution, provider-specific reads, generated creation, and legacy generated retirement.
2. Add stable artifact references to Rust canonical timeline DTOs and row derivation. Handle all snapshot/page/observer paths and live publication.
3. Keep artifact admission, native reset fencing, captured reads and view revisions coherent. Artifact commit followed by publication failure must remain recoverable through canonical reads.
4. Verify old-card bridge validity, per-artifact grants, approval scoping, retirement/orphan rejection, and no cross-thread authority leakage.
5. Regenerate OpenAPI and frontend types with the checkout exporter.

Exit: two clients observe identical independently addressable cards and positions after create, missed events, reconnect, restart and older-history loading. Revert cannot resurrect an obsolete placement. External MCP imports and panes still work in mixed-provider threads.

### M3 — Inline host and content-driven layout

1. Add a focused generated-card renderer under the timeline/app-surfaces domain; do not expand App.tsx responsibilities.
2. Implement sandboxed content measurement, full document height, responsive reflow, and load/error/fallback UI.
3. Render cards outside collapsed work immediately on canonical publication. No expand/collapse/pane actions.
4. Use normal virtualization and the documented reset behavior. Keep local UI interactions and explicit bridge submission working.
5. Retire restored generated workspace panes while preserving external panes.

Exit: short and tall cards work with the chat's single vertical scroll at wide and narrow pane sizes; late content growth does not cause loops, clipping or reader jumps. Unmount/remount resets are acceptable and visible. New cards do not steal focus or reload existing visible cards.

### M4 — Agent guidance, integration validation and cleanup

1. Update `runtime/kodex/skills/kodex-generative-ui/SKILL.md`, its agent metadata, tool descriptions, and relevant README guidance for create-only inline generation. Mention reset behavior, responsive content, no viewport shells, and no automatic on-load submissions.
2. Update the embedded inventory only if files are added or removed; do not edit installed caches. Remove superseded generated replacement/presentation code and tests while retaining external-pane coverage.
3. Run focused backend/frontend tests, generated-contract checks, frontend build and relevant trims.
4. Independently review every implementation chunk using the repository's prescribed review agent, with fixes and verification by the main agent.
5. Use Playwright bundled Chromium and agent-browser for browser-observable acceptance. Locate the agent-browser skill before validation; if unavailable, report that limitation rather than claiming that evidence.
6. Update this plan and plans/index.md only when exit conditions pass. Commit coherent tested chunks; deployment/push remain separate instructions.

Exit: acceptance below passes, docs/types are current, independent review has no unresolved major issues, and no unrelated storage or external app behavior regresses.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Create A, request revision B | Both remain visible at their own origin points; A's content/grants are unchanged |
| Create before final answer | Card appears immediately outside collapsed work, without moving when the turn completes |
| Multiple creates/concurrent calls | Stable verified order; no accidental replacement, duplicates on refill, or wrong-thread attachment |
| Two tabs; one misses events | Canonical refills converge with no reload required; explicit submits from either remain ordinary fresh inputs |
| Restart/reload/older pages | Artifacts reappear with their correct anchors; only mounted cards fetch HTML |
| Revert during creation/read | Obsolete placement cannot reappear; preserved orphan artifact cannot submit actions |
| External MCP app in the same thread | Existing pane import, lookup, presentation and bridge behavior still work |
| Legacy generated pane restored | Clear retired state; no invented history placement or active legacy bridge |
| Scroll away/back, theme remount | Unsent state may reset; no duplicated conversational action on mount |
| Tall card, images, conditional sections | Natural height, no host document scrollbar/cap, no resize loop, usable chat scroll |
| Narrow fine pointer, narrow/wide touch, hybrid | Responsive content and usable controls; adjacent panes size independently |
| Keyboard and read-only observer | Focus stays predictable; observers get fallback content without executable controls |
| Forged/stale frame or unauthorized bridge | Rejected with scoped errors; another card's creation does not invalidate valid older cards |
| Failed render or submission | Meaningful fallback/error; no hidden auto-retry or false success |

## Review notes

Planning self-review checked the six user decisions against storage, projection, input routing, iframe lifecycle and responsive ownership. The principal implementation gate is reliable origin correlation; the principal browser risk is content measurement interacting with virtualized scrolling. Neither is treated as already solved.


## Completion evidence

- M1: the pinned official 0.160.0 runtime proves Code Mode call-ID correlation for concurrent and sequential native calls. The real built-in create proof creates two independent cards before the final answer, rejects a foreign thread, and preserves placements and the first card's bridge token across a cold restart. The built-in Control ownership and external hosted-widget proofs also pass using disposable state.
- M2: gateway regressions cover identical canonical publication to two subscribers, immutable documents/grants, fresh message IDs for repeated actions, native reset/approval admission fencing, retired/orphan rejection, and storage preservation. Older-page refills restore the card immediately after its anchor without duplicates; another thread receives no placement. Rust DTOs generate the committed OpenAPI frontend types; the breaking create-only surface uses API epoch 4.
- M3: bundled Chromium covers wide/narrow fine-pointer and touch layouts, independent cards, grow/shrink past 1,600px without document scrolling, composer focus on arrival, old-card actions, missed-event reconnect and reload. Separate above-viewport size notifications exercise stationary readers and paused readers within 60px of the bottom. Those tests observe a real sandbox proxy and host/virtualizer resize, rather than requiring offscreen child-document animation frames to run. Native document measurement is covered separately by the visible grow/shrink flows. Normal iframe unmount/reset remains intentional.
- M4: runtime skill, tool descriptions, agent metadata and README use the new create-only contract. Legacy generated pane rendering/presentation/bridge access is retired without importing its history or deleting stored documents; external MCP pane behavior remains covered.

Verification completed:

- `cargo test -p kodex-gateway`: 758 library tests plus four ordinary integration/binary tests pass; opt-in native tests remain ignored by default.
- `KODEX_TEST_CODEX_BINARY=/Users/jtkw/.local/share/kodex/current/native/bin/codex cargo test -p kodex-gateway --test native_app_server -- --ignored generated_ real_native_builtin_control_bundle_uses_its_owned_gateway_and_explicit_target real_native_hosted_widget_origin_account_bridge_and_cached_reopen`: four disposable native proofs pass.
- `cd apps/web && npm test -- --maxWorkers=4`: 175 files, 1,347 tests pass; one existing test is skipped.
- Playwright `inline-generated-ui`, `native-app-surfaces`, `thread-pane-scroll` and `workspace-thread-scroll`: 23 applicable cases pass, including the two corrected resize probes; two existing shape-specific split-pane cases skip. The resize probes were rerun after fixing fixture readiness and the assertion that had incorrectly required an offscreen iframe to stay mounted.
- `npm run generate:api`, frontend build, frontend trim, backend trim, formatting and diff checks pass. No new theme roles or shared color mappings were added.
- Agent-browser inspected the disposable Playwright Chromium instance through CDP, including a narrow chat beside a spacious draft pane; the screenshot and DOM inspection showed independent inline cards and no pane/expand controls, and the browser error inspection was clear.

Independent GPT-5.6 Sol/high reviews covered native origin evidence, backend ownership/reset/retirement behavior, frontend lifecycle/errors/focus, and the resize correction. All required findings were fixed; no major issues remain. The running service and user-owned workspace data were not deployed, imported or reset.
