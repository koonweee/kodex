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
| 3. First real chat slice | Active | Kodex UI → TypeScript/oRPC → Code SDK create/open/stream/Send/Queue/Stop/history; two clients converge across reconnect/restart. Repo remains runnable alongside old production. |
| 4. Retained product workflows | Pending | Milestone-sized work for goals, automations, projects/pins/read state, terminal, Control tools, file/app panes and PWA. Detail only when preceding milestones inform the design. |
| 5. Production cutover | Not authorized | Separate deployment scope after retained workflow acceptance, operational checks and user authorization. |

## Current work

Completed [built-runtime memory evaluation](mastra-memory-evaluation.md): 48 paired cases / 60 live turns and 14 staged probes passed. Plain-Node Mastra measured roughly 340/344/351 MiB idle for 1/5/15 chats and 392 MiB at the five-concurrent-chat sampled peak, about 30–36% below tsx. Full SDK import dominates the separate empty-session probe; fixed overhead remains, but a large per-chat penalty is not demonstrated. Use built code for production-like comparisons. Long-history/sustained/plugin workloads remain future validation, not an inferred blocker.

Milestone 2 is complete under the [baseline-scoped configuration audit](mastra-config-isolation.md). Global/project/environment resource overrides change native default metadata but do not mix explicit chat identities, persisted history or resumed model input. Namespaced MCP reads, external file edits, native reload and persisted project disable state behave predictably. Global changes require reload on each affected project manager; eventual Kodex routing must coordinate that and browser refills.

Active: the first real Kodex UI → oRPC → Code SDK chat slice. Retain the existing shell, docking, composer and timeline; replace their backend orchestration with native oRPC hooks. Keep unfinished controls visible with ordinary errors against the new backend, without app-server fallback. Use separate development ports and leave production untouched. No SDK patch or move to Core is justified by these checks. Keep native explicit resource/thread identities and the accepted CLI/file MCP setup; the current app-server's versioned browser config writer is not implemented by the Mastra manager. Product MCP wiring remains pending and disabled by default; plugins/hooks remain unverified. Instruction bookkeeping and zero ambient reads are not blockers. The MCP fixture requires explicit subprocess exit after successful assertions/awaited teardown, so natural shutdown/hot retirement is not proven.

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

Latest completed chunk: 43/43 tests, TypeScript check, build and independent source/results review pass. Memory evaluation: 48 paired cases / 60 correct live turns, plus 12 ordinary stage probes and 2 separately labeled GC diagnostics. Earlier configuration ownership checks pass without runtime patches. No deployment or production UI migration. Long-context behavior, plugin execution/concurrency, HTTP MCP/OAuth and natural process retirement remain unproven.

### First chat slice — implementation started

- Active goal: create/open, persisted history, streamed text/tools, Send/Queue/Stop, and two-tab/reconnect/restart convergence through the existing Kodex UI. No deployment.
- Fixed runtime disposal tracking to use native resource/scope registry identity rather than the shared default session ID. Regression reproduced the overwritten cleanup entries; all three distinct native sessions now settle and leave the registry. Targeted test and independent review pass. Native detached-write shutdown limitations are unchanged.
- Native chat service and frontend orchestration are being implemented. Full snapshots remain a bounded spike choice; paging/deltas and retained product workflows are later milestones.
