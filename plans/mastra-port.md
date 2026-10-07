# Kodex Mastra port — running implementation log

Updated: 2026-10-07. Status: Active. This is the running status document for the port; update it at every implementation boundary, including blockers, validation and the next concrete step.

## Workspace

- Worktree: `/Users/jtkw/Projects/kodex-mastra-spike`.
- Branch: `codex/mastra-sdk-spike`.
- Main checkout: `/Users/jtkw/Projects/kodex`, still on `main`, with unrelated ongoing changes. Do not modify or merge those changes implicitly.
- No deployment, service restart or push authorized by this port task. Existing production remains intact.

## Governing decisions

Full Mastra Code SDK, TypeScript/oRPC backend and retained React/Vite UI. Mastra owns execution, tools, history, memory, goals and scheduling wherever supported. Kodex owns its product projection and minimal coordination. One process supports multiple projects/chats; use distinct native per-chat identities. Fresh dedicated profile and ChatGPT login. No sandbox; localhost/trusted VPN only. Native volatile queues/Stop and restart limitations are accepted. MCP Apps deferred. Preserve a browser widget extension seam. Do not revive the abandoned generic adapter or Pi migration.

See the [decision handoff](mastra-code-sdk-handoff.md) for the complete accepted scope and [compatibility spike](mastra-code-sdk-spike.md) for proofs and limitations.

## Milestones

| Milestone | Status | Exit conditions |
| --- | --- | --- |
| Compatibility and ownership proof | Complete | Native concurrency/history/queue/goals/schedules/oRPC proofs and narrow shutdown characterization. |
| Baseline and cache diagnosis | Complete | [Benchmark](mastra-code-sdk-benchmark.md) and [cache investigation](mastra-cache-investigation.md); cache affinity cause reproduced. |
| 1. Supported ChatGPT affinity | Complete | Use public per-request/session hooks, no global fetch patch; fixture coverage for isolation/tool steps/retry/resume and native live validation; rerun original paired workload. |
| 2. Dedicated configuration isolation | Active — upstream gaps | Verify actual SDK discovery paths and supported options; enable plugins/MCP only after isolation and concurrency are proven. No HOME swapping/custom discovery system. |
| 3. First real chat slice | Pending | Kodex UI → TypeScript/oRPC → Code SDK create/open/stream/Send/Queue/Stop/history; two clients converge across reconnect/restart. Repo remains runnable alongside old production. |
| 4. Retained product workflows | Pending | Milestone-sized work for goals, automations, projects/pins/read state, terminal, Control tools, file/app panes and PWA. Detail only when preceding milestones inform the design. |
| 5. Production cutover | Not authorized | Separate deployment scope after retained workflow acceptance, operational checks and user authorization. |

## Current work

Milestone 2: [config audit](mastra-config-isolation.md) verified. The supported `initialState.homeDir` fix now confines native skills discovery to the dedicated profile and the current project. Auth/settings/storage already use the dedicated profile. MCP/plugins/hooks remain disabled.

Complete no-real-home-read isolation still needs upstream support: MCP and project resource metadata ignore `homeDir`; the built-in instruction-path deduplication helper ignores global skip/config-directory options. The latter reads text only to derive paths, with no demonstrated global prompt injection. Avoid HOME mutation, loader forks and a process-global resource-ID workaround. Native plugin/hook paths support the dedicated home, but execution/concurrency remains unproven.

Next: prepare narrowly scoped upstream fixes or track these gaps while proceeding to the first chat slice with optional integrations disabled. Full isolation is not marked complete.

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

## Validation ledger

Latest completed chunk: 38/38 spike tests, TypeScript check and independent configuration/source/implementation review pass. The skill discovery test failed before the fix and passes after it. Previous affinity milestone: 12 paired benchmark cases / 28 live turns passed; no live benchmark was repeated for this configuration change. No production UI migration is implemented. Long-context behavior, arbitrary plugin concurrency and complete discovery isolation remain unproven. Update this ledger as each milestone progresses.
