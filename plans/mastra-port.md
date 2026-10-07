# Kodex Mastra port — running implementation log

Updated: 2026-10-07. Status: Active. This is the running status document for the port; update it at every implementation boundary, including blockers, validation and the next concrete step.

## Workspace

- Worktree: `/Users/jtkw/Projects/kodex-mastra-spike`.
- Branch: `codex/mastra-sdk-spike`.
- Main checkout: `/Users/jtkw/Projects/kodex`, still on `main`, with unrelated ongoing changes. Do not modify or merge those changes implicitly.
- No deployment, service restart or push authorized by this port task. Existing production remains intact.

## Governing decisions

Full Mastra Code SDK, TypeScript/oRPC backend and retained React/Vite UI. Mastra owns execution, tools, history, memory, goals and scheduling wherever supported. Kodex owns its product projection and minimal coordination. One process supports multiple projects/chats; use distinct native per-chat identities. Fresh dedicated profile and ChatGPT login. No sandbox; localhost/trusted VPN only. Native volatile queues/Stop and restart limitations are accepted. MCP Apps deferred. Preserve a browser widget extension seam. Do not revive the abandoned generic adapter or Pi migration.

**Compare every Mastra issue against the current Kodex app-server implementation before treating it as a blocker or proposing extra machinery.** State the actual app-server guarantee/limitation, the Mastra behavior, and the concrete user-visible difference. Distinguish demonstrated regressions, accepted native differences, unverified behavior and optional improvements. Do not silently raise the port's requirements beyond the existing product or reopen explicitly accepted simplifications. Prefer native ownership; justify patches, custom coordination or a move to Core by the product impact and ongoing maintenance cost, not by an idealized isolation or lifecycle standard.

Configuration example: the current app-server isolates owned credentials/state but accepts ambient skills and project configuration. For this port, require separate credentials/state and predictable configuration ownership; zero reads outside the dedicated directory is not a requirement. See the [baseline boundary](../docs/audits/2026-10-04-app-server-native-audit.md) and [configuration audit](mastra-config-isolation.md).

See the [decision handoff](mastra-code-sdk-handoff.md) for the complete accepted scope and [compatibility spike](mastra-code-sdk-spike.md) for proofs and limitations.

## Milestones

| Milestone | Status | Exit conditions |
| --- | --- | --- |
| Compatibility and ownership proof | Complete | Native concurrency/history/queue/goals/schedules/oRPC proofs and narrow shutdown characterization. |
| Baseline and cache diagnosis | Complete | [Benchmark](mastra-code-sdk-benchmark.md) and [cache investigation](mastra-cache-investigation.md); cache affinity cause reproduced. |
| 1. Supported ChatGPT affinity | Complete | Use public per-request/session hooks, no global fetch patch; fixture coverage for isolation/tool steps/retry/resume and native live validation; rerun original paired workload. |
| 2. Configuration ownership against app-server baseline | Complete — bounded checks | Verify separate credentials/state and predictable configuration ownership. Test material identity/discovery effects and MCP read/edit/reload consistency before enabling; plugin concurrency remains unverified. Zero real-home reads is not an exit condition. |
| 3. First real chat slice | Complete — bounded spike | Kodex UI → TypeScript/oRPC → Code SDK create/open/stream/Send/Queue/Stop/history; two clients converge across reconnect/restart. Repo remains runnable alongside old production. |
| 4. Main frontend end-to-end on Mastra | Active | Milestone-sized work for goals, automations, projects/pins/read state, terminal, Control tools, file/app panes and PWA. Detail only when preceding milestones inform the design. |
| 5. Production cutover | Not authorized | Separate deployment scope after retained workflow acceptance, operational checks and user authorization. |

## Current work

**Active: [main frontend end-to-end parity](mastra-frontend-parity.md).** The user confirmed a live UI prompt works, then requested essentially the latest-main frontend on Mastra with minimal UI change. Freeze initial main at `00d22832cb43a2784826b1eb9a25689d4b1e5eba`; merge it once now, defer subsequent main drift to the end. Backend integration should serve the existing UI; accidental UI differences are bugs. Stop only for genuine unresolved product decisions, otherwise continue through end-to-end implementation and validation.

Completed [built-runtime memory evaluation](mastra-memory-evaluation.md): 48 paired cases / 60 live turns and 14 staged probes passed. Plain-Node Mastra measured roughly 340/344/351 MiB idle for 1/5/15 chats and 392 MiB at the five-concurrent-chat sampled peak, about 30–36% below tsx. Full SDK import dominates the separate empty-session probe; fixed overhead remains, but a large per-chat penalty is not demonstrated. Use built code for production-like comparisons. Long-history/sustained/plugin workloads remain future validation, not an inferred blocker.

Milestone 2 is complete under the [baseline-scoped configuration audit](mastra-config-isolation.md). Global/project/environment resource overrides change native default metadata but do not mix explicit chat identities, persisted history or resumed model input. Namespaced MCP reads, external file edits, native reload and persisted project disable state behave predictably. Global changes require reload on each affected project manager; eventual Kodex routing must coordinate that and browser refills.

Completed: the first real Kodex UI → oRPC → Code SDK chat slice. Retain the existing shell, docking, composer and timeline; replace their backend orchestration with native oRPC hooks. Keep unfinished controls visible with ordinary errors against the new backend, without app-server fallback. Use separate development ports and leave production untouched. No SDK patch or move to Core is justified by these checks. Keep native explicit resource/thread identities and the accepted CLI/file MCP setup; the current app-server's versioned browser config writer is not implemented by the Mastra manager. Product MCP wiring remains pending and disabled by default; plugins/hooks remain unverified. Instruction bookkeeping and zero ambient reads are not blockers. The MCP fixture requires explicit subprocess exit after successful assertions/awaited teardown, so natural shutdown/hot retirement is not proven.

Milestone 1 uses the public `inputProcessors → processInputStep → modelSettings.headers` seam. The stateless processor uses persisted native thread IDs and native request-scoped credential selection for ChatGPT OAuth. No provider replacement, auth fork, global fetch interception or body cache key is used in runtime integration.

### Supported integration benchmark

The full paired workload passed all 12 cases / 28 live turns. [Sanitized report](../spikes/mastra-code-sdk/results/benchmark-affinity-2026-10-07.json). Same pinned model, low effort and workload as the original benchmark; fresh histories reuse provider caches. Configuration remained unchanged apart from affinity so the skill-home correction is a separate next chunk.

| Sequential workload | Original Mastra | Integrated Mastra | Paired Codex rerun |
| --- | ---: | ---: | ---: |
| Input tokens | 237,183 | 237,219 | 209,117 |
| Cached input | 19.9% | 75.6% | 86.9% |
| Uncached input | 190,079 | 57,763 | 27,357 |

Mastra follow-up sentinel requests reached 98.6% cached input; file tasks reached 85.1%. First-request and tool-turn reuse still vary. This is a supported affinity proof, not cache parity or a billing measurement. The rerun is not a randomized causal estimate; controlled attribution is in the earlier cache investigation. Mastra median sequential loaded RSS remains about 628 MiB versus Codex's 234 MiB including its Node benchmark wrapper (175 MiB native child). Short-task latency was comparable; realistic coding and long-context memory remain unmeasured. The config audit found skills may still come from the real home, so do not interpret either benchmark as proving fully isolated/default-only context.

## Change log

- `5f0fd1f`, `8e4a4f3`, `538a0c4`: compatibility scaffold/proofs and native shutdown characterization.
- `2e47204`: model-switch handoff.
- `674b388`: paired short-task benchmark, 28 live turns passed.
- `f7767a6`: cache-affinity investigation, 42 correct live responses plus 2 rejected capability probes; 32 fixture tests pass.
- 2026-10-07: user authorized implementation sequence and requested this running document. Confirmed main remains on `main`; implementation worktree clean before this chunk.
- 2026-10-07: supported affinity implemented and independently reviewed. Unit and actual-runtime fixture coverage includes concurrent chats, native file tools, HTTP retry and persisted reopen; full paired live workload passed. Config discovery audit recorded separately.

- 2026-10-07: configuration check found and fixed native skill discovery using public state `homeDir`; independent source and implementation review clear. Remaining MCP/resource/instruction-path reads documented. No live calls, production changes or user credential reads.

- 2026-10-07: upstream report/config-option research found open issue #23241 and unmerged restricted API PR #23991. The proposed API omits retained native capabilities; current partial controls remain in use. See the configuration audit for links and release status.

- 2026-10-07: user established app-server baseline comparison as a guiding principle for every Mastra issue. Reframed configuration milestone around owned state and predictable behavior, not complete discovery isolation.

- 2026-10-07: both requested configuration ownership checks pass: three resource override cases and native MCP precedence/edit/reload/disable-state proof. Configuration milestone complete within the accepted baseline; first chat slice next.

- 2026-10-07: repeated built-vs-tsx memory evaluation completed; results materially reduce the earlier overhead concern. Native-first Code SDK direction retained, realistic workload validation remains scoped to future integrations.

## Validation ledger

Latest completed chunk: 51/51 backend tests, 1,076/1,076 frontend tests across 149 files, TypeScript checks, backend/default-frontend/Mastra-frontend builds, frontend trim and independent backend/frontend review pass. Real native SDK browser acceptance passes desktop, narrow fine pointer and narrow touch (bundled Chromium), including two tabs, Send/Queue/Stop, actual file-tool output, history reload and SIGKILL/restart convergence. Memory evaluation: 48 paired cases / 60 correct live turns, plus 12 ordinary stage probes and 2 separately labeled GC diagnostics. Earlier configuration ownership checks pass without runtime patches. No deployment or production cutover. Long-context behavior, plugin execution/concurrency, HTTP MCP/OAuth and natural process retirement remain unproven.

### First chat slice — implementation started

- Active goal: create/open, persisted history, streamed text/tools, Send/Queue/Stop, and two-tab/reconnect/restart convergence through the existing Kodex UI. No deployment.
- Fixed runtime disposal tracking to use native resource/scope registry identity rather than the shared default session ID. Regression reproduced the overwritten cleanup entries; all three distinct native sessions now settle and leave the registry. Targeted test and independent review pass. Native detached-write shutdown limitations are unchanged.
- Native chat service and frontend orchestration are being implemented. Full snapshots remain a bounded spike choice; paging/deltas and retained product workflows are later milestones.

- Native chat backend implemented: CLI-configured projects and stable profile identity; typed oRPC inventory/create/open/watch/Send/Queue/Stop; shared native sessions; validated inputs and no legacy-route fallback. Full backend suite 51/51, check/build and independent review pass. Strengthened service checks verify exact human input in native user-authored signal rows, not only matching assistant text.
- Frontend integration remains active. Real browser flow reaches two-tab chat, queue/stop, native file tool and reload. Browser checks exposed a Vite upstream-abort propagation gap and omitted native user-signal rendering; fixes are being verified before milestone completion. Existing frontend regression suite also found one loading-state failure under investigation.

### First chat slice — acceptance complete (2026-10-07)

- Existing Kodex shell/sidebar/docking/composer/timeline now run through the opt-in Mastra backend. Native oRPC types are inferred from the server router; Rust/OpenAPI production contracts are unchanged. Separate dev ports and explicit mode prevent fallback into app-server. Setup: [UI spike commands](../spikes/mastra-code-sdk/README.md#existing-kodex-ui-spike).
- Native fixtures prove shared chat identity, exact persisted human inputs (including user-authored signal rows), concurrent commands, admission acknowledgment, unknown-ID rejection, errors and restart history. Native runs outlive an observer disconnect. Kodex adds no durable transcript/queue.
- Real browser acceptance uses the actual SDK and local model, not mocked gateway responses. In each of three viewport/input modes, two tabs see streamed text/tools and acknowledged queue counts, Stop allows a queued follow-up, reload preserves history, a killed/restarted backend converges to idle without reload, waiting input is dropped, and a new Send works from the other tab. The fixture requires the native file tool's real marker output. Screenshots reviewed on desktop and touch; no uncaught page errors or old `/v1/events` connection. The unavailable agent-browser skill was replaced by this bundled-Chromium Playwright evidence.
- Regressions fixed before acceptance: missing user-signal rows; reconnect's first equal-revision snapshot rejected despite newer native persistence; Vite proxy failing to close its browser response after upstream abort; eager native-shell imports changing the original app-server loading state. Tests reproduced the faults and remain in place. Full existing frontend suite passes.
- Unported account/settings/pins/project creation/attachments and queue-management panels remain visible with ordinary errors, as requested. Native Queue itself works; its count comes from Mastra. No claim of retained-product parity. Projects are configured by CLI; native histories and profile identity survive backend restart.
- Limits: full-history snapshots, no history paging/deltas, late native title writes discovered by refills, no auth/sandbox, plugins/hooks/MCP still disabled. No new live ChatGPT browser request was made in this chunk; previously verified OAuth/runtime integration remains in place. Failed/aborted runs may still have trailing native writes when storage closes; completed-answer persistence proofs do not imply a universal shutdown drain.
- Implementation commits: `3439b38` session disposal prerequisite; `36db079` native chat service/server; frontend integration and browser acceptance follow in the next commit. Main checkout and running service were not changed by this work.

Next: choose the next retained-product milestone against current app-server behavior. The initial chat slice is complete; goals/automations, project/pin/read metadata, terminal/Control/file surfaces and PWA remain pending. No production cutover is authorized.

- 2026-10-07: Full frontend port authorized. Durable parity plan added; pinned initial main reference `00d22832cb43a2784826b1eb9a25689d4b1e5eba`. Preserve latest-main UI/workflows, distinguish unimplemented features from native limitations, and seek clarification only for decisions that materially require it. Initial merge next.

- Initial parity merge: main frozen at `00d2283`; three frontend conflicts resolved. Build/trim and independent merge review pass; existing native browser flow remains green on desktop/narrow fine/touch. Detached baseline proved 18 pre-existing main test failures; contract/layout expectations being updated in the port branch. Workflow inventory and native capability distinctions recorded in the parity plan.

- Frozen-main merge validated: 1,125 frontend tests across 154 files pass after reviewed baseline test corrections; build/trim and independent merge review pass. Native two-tab/tool/reload/restart browser acceptance passes all three viewport/input configurations. Native model/reasoning settings and queue mutation proofs are the next active slices.

- Main pane chrome restored: removed duplicate visible in-pane title and moved actions into existing workspace header with stable registration/cleanup. Independent review clear; focused lifecycle tests and full frontend suite pass. Actual browser screenshots reviewed on desktop and narrow touch; all three native E2E flows pass. Visible settings/queue errors remain tracked WIP, not parity acceptance. Frozen merge commit: `5677510`.

- User decision: keep native Mastra queued settings. Model/reasoning changes affect new submissions; already-waiting work keeps captured settings. No extra dispatcher or automatic cancel/requeue to emulate app-server execution-time defaults. Native queue proof additionally covers remove/edit/reorder/steer, partial cancellation, uncertain handoffs and preserved suffix order.

- Native model/reasoning UI slice validated: main controls reused, sparse shared updates, canonical watch ownership, explicit local draft creation settings, native profile version conflicts and effective reasoning mapping. Full frontend 1,132/1,132 and backend70/70 passed, followed by focused review regression checks; three actual-SDK browser configurations prove two-tab settings updates and restart persistence. Fast wire feasibility proven; full Fast product wiring remains pending. Account native read/logout/quota and auth-file observation foundations are implemented/tested/reviewed but not yet wired to RPC/UI.

- 2026-10-07: user explicitly accepted native enqueue-time model/reasoning/Fast settings. Queue editing/reordering retains prepared options for untouched input; an explicit edit is a new submission. Account/footer and Fast integration are in progress. A live dedicated-profile ChatGPT usage read succeeded (primary window present) using native credential ownership; no model request or secrets logged. Actual two-tab browser validation exposed HTTP/1 stream exhaustion; moving browser transport onto the framework-native oRPC WebSocket adapter, retaining HTTP RPC and no mutation replay. Acceptance remains pending.

- 2026-10-07: account/Fast/shared-transport slice validated: frontend 1,152/1,152, build/trim; backend pre-transport 79/79; real SDK browser two-tab/restart flows 3/3 across desktop/narrow mouse/touch. Independent review caught and fixed canceled calls being sent after a pending WebSocket handshake. The native codec remains responsible for framing/cancellation; only future calls reconnect, with no mutation replay. Account uses native credential storage and main menu/footer; live quota read and actual Fast-wire fixture passed. Parent review of server adapter and touch screenshot complete. Queue editing/recovery integration is next; full frontend parity remains active.

- Shared transport final proof: 5/5 server tests and backend typecheck pass, covering twelve concurrent iterators plus ordinary WebSocket/HTTP RPC, per-call cancellation, disconnect and joined shutdown cleanup, same-origin browser upgrades, payload bounds and generic malformed/provider failures. Browser link independently reviewed with 10/10 real-codec tests.

- Local dev backend refreshed to the validated shared-transport build on 8789; read-only WebSocket info check passes. During shutdown, its prior native title-generation log reported ChatGPT rejecting a nonstreaming request (`Stream must be set to true`). Track this in the upcoming title/metadata slice against main’s native preview/manual-name behavior; do not infer ordinary streamed-chat failure or introduce a duplicate title agent. No production restart.

- 2026-10-07: queue slice validated against real native SDK/browser: same main queue presentation, sparse versioned edits, native captured settings, exact-ID removal/steering/recovery and no replay. Full suites frontend 1,166/1,166/backend93/93, focused queue24/24, frontend58/58, build/trim and independent review clear; three viewport/input browser flows pass including stale two-tab editor and restart. Review caught/fixed the native receipt response envelope and memory-only persistence masquerading as a delivery event. Project/sidebar metadata is next.

- Queue restart supplement: fresh-process disposable SIGKILL proof passes independently, confirming completed native history survives, volatile queued rows/new runtime epoch reset and inventory reads do not execute lost work. Final backend typecheck and independent review pass.

- Native title/metadata audit: four actual SDK tests pass as capability/limitation characterization; two demonstrate lost-update bugs (rename vs setting, usage vs title/pin). Independent parent review clear. A complete repair spans native Core/Memory/LibSQL write semantics; user direction requested before taking on patched-dependency maintenance. Project/registry integration continues independently. No native SDK patch yet.

- 2026-10-08: project registry/backend integration passes independent review and focused real SQLite/native tests. Immutable execution bindings retain original cwd/history across project root edits, deletion and same-path recreation; CLI project seeds are one-time and standalone-only startup is supported. Existing main project controls are being connected to canonical catalog/oRPC; real two-tab browser validation remains pending. No production changes.

- Project UI checkpoint validated: full backend110/110 and frontend1,172/1,172 pass, followed by final focused frontend29/29 and strengthened shell2/2. Backend check/build, native frontend build, strict trim and independent review pass. Actual SDK/browser6/6 across desktop/narrow mouse/touch prove both queue/settings flow and project create/edit/delete with two-tab convergence and detached history/Send across killed-backend restart. Parent reviewed touch screenshot; expected unported sidebar/goal errors remain visible. Dedicated local development backend8789 refreshed to the tested built API; read-only info/catalog succeeds (one project/one native chat). Production untouched. Next work is sidebar metadata; native title/settings lost-update repair still awaits user direction.
