# Native harness cache investigation

Status: Complete (bounded cache-affinity investigation). 2026-10-07. Branch: `codex/mastra-sdk-spike`.

## Objective

Explain the short-turn cache gap in the Mastra/app-server benchmark with isolated wire-level experiments and primary-source research. Preserve native runtime behavior; no production changes, SDK patches, credential copying or upstream publishing. Compaction is a separate variable: the prior 39.7k file-task input sums two calls, and native observation thresholds count conversational history rather than system/tool schemas.

## Method

- Capture request bodies only in memory in a disposable diagnostic process; save component hashes, lengths, role/type, known configuration values and numeric usage only.
- Compare native successive requests: static instructions, tool inventory/order and unchanged history prefix.
- Replay identical bodies using the native OAuth transport; separately test cache key, session affinity header, implicit mode and explicit breakpoint capability. Stop rejected treatments after one response.
- Use existing dedicated auth and disposable histories. Keep raw auth, headers and prompts out of artifacts; no production requests intercepted.
- Research current official documentation, exact pinned Codex source and upstream first-hand reports. Distinguish API documentation from ChatGPT backend support, reported issues from reproduced causes, and cache metrics from subscription billing.
- Add targeted measurement tests, independent review and an evidence-backed result before completion.

## Findings

**Missing ChatGPT session affinity explains a reproducible, avoidable part of the measured cache gap.** The pinned Mastra Code SDK 1.10.1 provider sends native `x-thread-id` / `x-resource-id` metadata but does not send the ChatGPT Responses **`session-id`** header. Setting that header to one stable value per conversation restored near-complete follow-up reuse in the bounded evaluation. No prompt, tool, memory or model changes were needed.

This changes how to interpret the [original benchmark](mastra-code-sdk-benchmark.md): its 6.7× uncached-input difference is a measurement of the stock integration tested, not an inherent Code SDK or observational-memory penalty. The small experiments below do not replace the earlier full workload benchmark or prove every tool-loop/long-context case is fixed.

### Controlled evaluations

All use the same native ChatGPT login, `gpt-6.1-sol`, low effort and pinned packages as the original benchmark. No credentials were copied. Fixture project paths and histories were disposable. The diagnostic fetch wrapper ran only in the isolated CLI process; it is not a proposed production integration.

1. **Four native stock turns:** hashes prove top-level instructions, all 31 tool definitions/order and existing input items stayed identical; history was append-only. Native cache values still varied (12,160 → 3,968 → 3,712 → 12,160). Thus prompt churn is not needed to reproduce this cache behavior.
2. **Identical-body screen:** plain replay and a stable body cache key alone remained inconsistent. Key plus `session-id` produced 12,160 cached tokens, then 19,584 twice out of 19,749 (~99.2%). This was a hypothesis screen with fixed treatment order, so the next controls matter more.
3. **Interleaved header test:** twelve requests had the **exact same full-body hash**, including the same cache key. Only the header treatment changed. Header-on warmed once at 3,968, then all five later requests cached **19,456 / 19,665 (98.94%)**. Header-off cached 3,968 in five of six requests and 12,160 once (median **20.18%**). Off requests remained low even after on requests warmed, which argues against simple elapsed-time/cache-warmup order explaining the effect.
4. **Native header-only test:** four fresh conversations, ordered **off / on / on / off**, each with four identical short user turns. No body cache key was added in any group. Both header-on conversations cached **19,456 tokens on every follow-up**, while off groups remained variable and lower. All sixteen turns completed correctly.

| Native follow-ups (first turn excluded) | Header off | Header on |
| --- | --- | --- |
| Observations | 6 | 6 |
| Total input | 118,386 | 118,386 |
| Cached input | 47,872 | 116,736 |
| Weighted cached share | 40.44% | 98.61% |
| Uncached input | 70,514 | 1,650 |

The off groups differed (~61.6% and ~19.2%), reinforcing that the backend/cache environment is variable. The header-on effect was consistent across the tested follow-ups. Do not present the uncached ratio as subscription cost savings, or extrapolate six turns to production tail latency.

**Capability tests:** adding `prompt_cache_options: {mode: "implicit"}` or a `prompt_cache_breakpoint` to the otherwise working subscription request yielded HTTP 400. Each treatment stopped after its first rejection. Those are rejected experiments, not zero-cache samples. We did not save raw error payloads; this result establishes rejection of those tested request shapes on this endpoint/account/model, not universal unsupported status on all OpenAI APIs.

Across the three runs: **44 request attempts, 42 successful correct completions and 2 intentional capability probes rejected with HTTP 400**. The endpoint reported numeric cache-write counts of zero in successful responses; do not interpret these as an API billing guarantee. All raw bodies remained in memory, while saved reports contain hashes/lengths, known role/type/config values, header presence booleans and numeric usage.

Evidence: [screen](../spikes/mastra-code-sdk/results/cache-screen-2026-10-07.json), [interleaved controls](../spikes/mastra-code-sdk/results/cache-affinity-2026-10-07.json), [native conversations](../spikes/mastra-code-sdk/results/cache-native-affinity-2026-10-07.json). Body hashes describe submitted JSON, not inaccessible server-rendered token streams. Replay requests use the same native OAuth fetch helper; their default headers differ from full SDK requests, so causal comparisons use the interleaved arms and native-only arms separately.

### Why this is not compaction

Pinned memory 1.35.0 counts current unobserved conversational history, excluding system messages and tool schemas; tool-call arguments/results count. SDK defaults are 30k observation history, 6k background buffering intervals and 40k accumulated observation tokens for reflection. The earlier 39.7k file-task number sums two API calls and does not measure 39.7k history. These new native requests preserve every previous input item; there is no observed compaction rewrite. Native temporal-gap markers require at least ten minutes; these short sessions did not cross that interval.

Sources: [pinned history counter](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/packages/memory/src/processors/observational-memory/observational-memory.ts#L2996), [SDK memory configuration](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/agents/memory.ts#L238), [temporal gap threshold](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/packages/memory/src/processors/observational-memory/date-utils.ts#L439).

## Upstream research and harness practices

### Directly relevant native implementations

- **Codex 0.160.0 explicitly documents this affinity mechanism.** Its client says ChatGPT derives cache affinity from the Responses `session-id` header. Its wire helper uses hyphenated `session-id` and `thread-id`; SSE also sets `x-client-request-id`. [Pinned client](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/client.rs#L559), [wire header construction](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/requests/headers.rs#L4), [SSE path](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/endpoint/responses.rs#L79). OpenAI removed underscore aliases because proxies can reject them: [merged PR #22193](https://github.com/openai/codex/pull/22193).
- **Pi 1.0.4 sends the header on HTTP/SSE and WebSocket paths.** Its issue tracks following the Codex header changes. [Pinned provider](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/openai-codex-responses.ts#L1555), [upstream issue #4967](https://github.com/earendil-works/pi/issues/4967). This supports a provider-integration fix rather than custom Kodex orchestration.
- **OpenCode** also has provider-specific cache-key and reasoning transformations. The inspected code establishes its implementation, not a comparable measured cache result or proof it uses the same affinity header. [Pinned 1.18.18 transformations](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/provider/transform.ts#L1184).

### Prompt-structure optimizations and reported failures

OpenAI's [January 2026 Codex agent-loop explanation](https://openai.com/index/unrolling-the-codex-agent-loop/) treats stable prefixes as a performance requirement: maintain deterministic tool ordering and append configuration changes instead of rewriting old input. It describes an actual MCP ordering bug. The article's transport discussion is historical; exact 0.160.0 source now includes WebSocket continuation/previous-response support, so do not use the old post to claim current Codex never uses it.

Mastra's [dynamic-context report #10381](https://github.com/mastra-ai/mastra/issues/10381) reports cache losses when a timestamp changes system instructions. That is a plausible failure mode, **not the reproduced cause here**: hashes stayed stable. SDK prompt dates are day-level, not a per-request clock.

OpenAI's [September 2026 caching update](https://openai.com/index/better-prompt-caching-for-gpt-6/) recommends stable tool schemas/order, appending instruction changes, controlled breakpoints and diagnostics. It reports improved caching from breakpoint tuning in other agent applications. These are API examples; our subscription endpoint rejected the tested explicit controls.

Upstream [Codex #35300](https://github.com/openai/codex/issues/35300) includes a first-hand report of explicit breakpoint gains on Bedrock and a separate report of those controls being rejected by ChatGPT. [Codex #47885](https://github.com/openai/codex/issues/47885) reports intermittent WebSocket cache losses. Treat these as reports with specific versions/backends, not universal guarantees or proof that native Codex has perfect caching.

The [current API guide](https://developers.openai.com/api/docs/guides/prompt-caching) says GPT-5.6+ cache routing is automatic and cache keys are optional for separate accounting. That does not establish the behavior of the ChatGPT subscription endpoint's `session-id` affinity header. Our measured body-key-only treatment did not repair reuse; the header did.

## Recommendation

Keep the full Code SDK direction. Seek a small native provider fix that maps the existing per-thread identity to a stable ChatGPT `session-id`, scoped per conversation and preserved across retries/tool steps. The native SDK already passes thread identity as `x-thread-id` through `getAgentControllerHeaders`, and `openaiCodexProvider` accepts provider headers; the missing mapping is narrow. Prefer an upstream fix or supported per-session provider hook, not a process-global fetch patch in Kodex.

Before relying on the fix for production, cover same-thread tool loops/retries, concurrent thread separation, provider/account isolation and restart/resume identity. Re-run the original paired workload with the supported integration. Then compare realistic long-running tasks across observation/compaction boundaries, including retained facts and recovery work. No arbitrary cache-key pooling across users or accounts, no custom transcript store, and no disabling native memory is justified by these results.

## Reproduction and validation

```sh
cd spikes/mastra-code-sdk
node --import tsx src/cache-evaluation.ts artifacts/new-screen screen
node --import tsx src/cache-evaluation.ts artifacts/new-affinity affinity
node --import tsx src/cache-evaluation.ts artifacts/new-native native-affinity
```

Requires the existing dedicated Mastra profile's native ChatGPT login. Commands make real model requests. Diagnostic monkey-patching is confined to disposable CLI processes. Full spike regression suite: **32/32 pass**. Typecheck: pass. Independent measurement/parser review: no major findings. Post-run hardening adds usage-bound checks and complete console diagnostic suppression; recorded successful samples satisfy those checks, and parser tests preserve valid-stream accounting. Independent final report review: no remaining major findings.
