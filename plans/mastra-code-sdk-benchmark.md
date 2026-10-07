# Mastra Code SDK versus app-server benchmark

Status: Complete (bounded short-task microbenchmark). Date: 2026-10-07. Branch: `codex/mastra-sdk-spike`.

## Scope

Measure native harness overhead before implementing the Mastra-backed Kodex chat slice. Use the same `gpt-6.1-sol` model at low effort, dedicated authenticated profiles and disposable project/history roots. Keep native tool inventories and instructions; report their differences. No production deployment or existing conversation imports.

## Method and exit conditions

- Three alternating-order repetitions per harness of a fresh-chat sentinel, same-chat follow-up and a file-reading arithmetic task. Check exact sentinels and computed JSON, with actual tool use.
- Measure native all-step turn token totals, known cached/uncached input, first nonempty assistant text and completion latency. First text may be commentary before tool use.
- Sample process-tree RSS every 500ms: one chat, five chats, three projects with five chats each, and five concurrently active chats. Separate Codex child RSS from the Node measurement wrapper.
- Test measurement/accounting and run typecheck plus the existing spike suite. Independently review implementation and conclusions.
- Publish results and limits; no inference of billing savings, production capacity or long-context behavior from short samples.

Native title generation is avoided using named threads. Short tasks are not expected to trigger observational-memory work; auxiliary title/observer/judge/subagent calls are not comprehensively metered. Reused provider caches are reported, not flushed. Disposable paths can change cache reuse.

## Results

All **12 cases / 28 live turns passed**, including tool-based file reads in both harnesses and five concurrent chats per harness. Measurements were taken on macOS arm64, Node 24.21.0, Code SDK 1.10.1 / core 1.74.0 / memory 1.35.0 / LibSQL 1.25.0, and Codex app-server 0.160.0. Both used ChatGPT login and `gpt-6.1-sol`, low effort.

[Normalized measurements, including every turn and RSS sample](../spikes/mastra-code-sdk/results/2026-10-07.json). Run `npm run benchmark` in the spike package to reproduce with fresh disposable fixtures and authorized native profiles.

### Short-task tokens and latency

Three repetitions each. Input below is median [min–max] per turn, summed across model steps. Cache percentages are weighted over the three turns, not the median of their percentages. Time is median first nonempty assistant text / native completion.

| Task | Mastra input tokens | App-server input tokens | Mastra cached | App-server cached | Mastra seconds | App-server seconds |
| --- | --- | --- | --- | --- | --- | --- |
| Initial sentinel | 19,682 [19,682–19,682] | 17,333 [14,260–17,333] | 19.7% | 75.3% | 3.43 / 3.85 | 2.58 / 2.81 |
| Same-chat follow-up | 19,721 [19,721–19,721] | 17,372 [17,372–17,908] | 19.7% | 88.5% | 2.38 / 2.74 | 2.53 / 2.73 |
| Read file and calculate | 39,658 [39,658–39,658] | 35,012 [34,998–36,069] | 20.0% | 90.3% | 7.61 / 8.21 | 6.40 / 6.61 |

Across all nine sequential turns per harness, Mastra used **237,183 input tokens**, versus **207,657** for app-server: about **14% more total input**. Native reported uncached input was **190,079 versus 28,457**, about **6.7×**. The cache difference is more consequential than the prompt-size difference in this sample, but this is not a billing or subscription-quota measurement, and its cause is not yet established.

Initial app-server context varied from 14,260 to 17,333 tokens with the same user prompt. Do not report the first trial alone as the definitive baseline. We retained native context/tool behavior rather than enforcing an identical prompt inventory. Mastra's initial input was consistently 19,682. The earlier 19.7k observation was total input, not an extra 19.7k over app-server.

Follow-up median latency was effectively equal; Mastra's initial response and file task were slower in this small sample. Five simultaneous simple replies all passed; native batch completion was **5.61s Mastra / 4.19s app-server** (one batch each). This does not establish general coding speed or capacity.

### Memory

MiB RSS. One-chat numbers are median [min–max] over three processes; other rows are single cases. Active numbers are sampled peaks. App-server native column excludes the Node benchmark wrapper; full tree includes that wrapper and transient descendants. Mastra's worker includes its native runtime and measurement wrapper together.

| Case | Mastra process tree | App-server native child | App-server full tree |
| --- | --- | --- | --- |
| 1 chat, idle | 627.0 [527.0–667.8] | 153.8 [148.5–170.7] | 212.9 [208.0–230.1] |
| 1 chat, active | 650.9 [554.7–703.4] | 205.3 [196.7–256.8] | 290.6 [281.6–316.3] |
| 5 chats / 1 project, idle | 628.5 | 236.5 | 296.1 |
| 15 chats / 3 projects, idle | 531.3 | 256.6 | 305.4 |
| 5 active chats / 1 project | 600.6 | 276.2 | 335.8 |

Mastra has a substantially larger process baseline here, but these short cases show no process-per-chat memory multiplication. The 15-chat process happened to use less RSS than the one-chat median; this is consistent with process/GC variability, not evidence that adding chats saves memory. Per-chat/per-project marginal costs and sustained active memory need longer, repeated measurements if they become a decision gate. These readings supersede the earlier unstructured idle estimates for this benchmark setup; they do not establish why those older readings differed.

### Limits and interpretation

- This is a controlled **short-task harness microbenchmark**, not a realistic multi-file coding evaluation. Empty fixture projects exclude repository instructions; both native tool inventories remain different. Mastra hooks/plugins/MCP/schedule tools and cross-agent signals are disabled by the spike; native coding tools and thread-scoped memory remain. Codex uses a fresh dedicated home with no configured MCP or installed custom plugins. Neither sandbox nor production gateway/browser overhead is included.
- Auth and provider caches were reused. There was one successful Codex pilot before the run (14,260 input / 12,288 cached / 11 output). Fresh native histories are not cold provider caches. The first Mastra process startup briefly overlapped the last second of fixture tests; model turns began after they ended. Memory is noisy and no CPU isolation was enforced.
- RSS sums resident pages, including possibly shared pages more than once, and 500ms sampling can miss brief peaks. No forced garbage collection or equalized native cache policy was applied.
- Main-turn token counters include tool-loop model calls, not all auxiliary calls. Named threads avoid automatic titles; no goals run. Observer/reflection/subagent billing is not independently intercepted. SDK normalization makes missing optional cache/reasoning indistinguishable from some genuine zeros, so those ambiguous values are conservatively unknown. All live cache totals were known; Mastra reasoning counts were unknown.
- First text can be commentary before a tool; completion is the better task-level comparison. Three sequential repetitions and one concurrency batch are too few for strong tail-latency claims.
- Review found and fixed asymmetric ancestor repository discovery before live measurement by moving fixtures outside the checkout. Native Session tags do preserve projectPath; the initial concern that all sessions would collapse to one root was not confirmed.

## Follow-up finding

The [cache investigation](mastra-cache-investigation.md) reproduced the gap with identical requests and identified missing ChatGPT `session-id` affinity in the pinned Mastra integration. Header-only native follow-ups reached about 98.6% cached input. The original 6.7× uncached difference is not an inherent Code SDK/compaction penalty. A supported provider integration and full workload rerun remain to be done.

## Original recommendation and next step

Keep Code SDK as a viable architecture candidate: the shared process supports concurrent chats without Pi's assumed process-per-chat footprint. Before committing the production migration, investigate why its prompt cache reuse is much lower on these short follow-ups, using supported native configuration and payload structure rather than custom orchestration. Establish whether this is a stable context prefix, cache-key/provider integration issue, or unavoidable harness behavior. Then run a small realistic coding task if needed; do not infer that replacing SDK tools/prompts or using core is already necessary.

Configuration/plugin/MCP isolation and a thin real UI → oRPC → Code SDK slice remain follow-on work. Production is unchanged.

## Validation

`npm test`: 25/25 pass. `npm run check`: pass. Independent source and results review: no remaining major findings. Measurement fixtures cover cumulative usage, tool-loop steps, missing/partial usage, final-answer extraction, process-tree accounting and the native driver. The added partial-usage rejection was fixture-validated after the live run; it does not alter positively reported live measurements. No deployment or push.
