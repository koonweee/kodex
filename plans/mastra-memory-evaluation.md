# Mastra built-runtime memory evaluation

Date: 2026-10-07. Status: Complete; bounded measurements and interpretation recorded. This follows the user's request to distinguish runtime/build overhead from multi-chat growth before the UI port. Evaluate against the current native app-server baseline rather than treating a larger process as a per-chat multiplier.

## Method

Keep Code SDK 1.10.1/core 1.74.0 and Codex 0.160.0 fixed. Compare the same benchmark source running via Node+tsx and emitted JavaScript under plain Node. `npm run build` emits source-only modules into ignored `dist/`; measured compiled workers have empty `execArgv`, verified by a regression fixture. Dependencies are already published JavaScript. This is transpilation, not dependency bundling/tree-shaking.

Repeat each scenario three times per launch mode and harness: 1 idle chat/1 project, 5 idle chats/1 project, 15 idle chats/3 projects, and 5 concurrently generating chats/1 project. There are 48 cases and 60 minimal live turns planned. Each case starts a fresh process and disposable history, using existing benchmark credentials only for live turns. Harness order alternates by repetition; launch-mode order alternates by scenario. This is a bounded local benchmark, not randomized load testing. The old sequential workload is intentionally excluded.

The driver samples process-tree RSS every 500 ms and uses a 1.1-second loaded-idle settling window. Report Mastra worker/tree, Codex native child and Codex tree separately; the latter includes the Node test wrapper. RSS is resident pages, not unique physical memory or retained heap. The benchmark parent is excluded; concurrent production applications are not controlled. Short sampled peaks can miss transient allocations.

A separate `memory-stages` diagnostic uses an empty disposable profile and no model calls. Each stage samples current-process RSS, heap used, heap total, external and array buffers five times at 200 ms intervals. Stages distinguish baseline, full SDK import, empty mounted project(s), and empty sessions. Single-project runs grow 1→5→15 chats; separate three-project runs create 5 chats each. Run three fresh processes per mode/scenario. These sessions do not reproduce history/model-save work from the paired workload; compare trends within each probe, not absolute values across probes.

One additional run per mode exposes GC and records explicitly labeled after-GC samples. These are diagnostic only: forced collections influence later stages. Current-process diagnostic RSS excludes any loader child, unlike paired process-tree RSS. Import-stage growth identifies the dependency initialization boundary, not which individual dependency or object retains memory.

## Reproduction

From `spikes/mastra-code-sdk`:

```sh
npm run build
node dist/benchmark.js --only memory-1 --memory-repetitions 3 --output artifacts/new-built-memory-1
node --import tsx src/benchmark.ts --only memory-1 --memory-repetitions 3 --output artifacts/new-tsx-memory-1
# Repeat for memory-5, memory-15 and concurrent-5 (--concurrent-repetitions 3).
node dist/memory-stages.js --scenario single-project --output artifacts/new-stages-built.json
node --import tsx src/memory-stages.ts --scenario three-projects --output artifacts/new-stages-tsx.json
node --expose-gc dist/memory-stages.js --scenario single-project --output artifacts/new-stages-built-gc.json
```

Benchmark output directories and diagnostic report files must be fresh. Live concurrency cases use the previously authorized isolated benchmark homes; do not use production credentials/stores. No deployed gateway is changed by this evaluation.

## Results and interpretation

All **48 cases / 60 live turns** passed. All 14 stage probes completed (12 ordinary fresh-process probes, 2 separately labeled GC diagnostics). [Sanitized consolidated measurements](../spikes/mastra-code-sdk/results/memory-build-comparison-2026-10-07.json) retain per-run metrics, aggregate ranges and stage medians; raw numeric samples remain under ignored `artifacts/memory-build-2026-10-07`.

RSS in MiB, median [min–max] across three runs per cell. Idle rows use each run’s median loaded-idle RSS; the active row uses each run’s sampled peak.

| Scenario | Mastra tsx tree | Mastra built tree | Codex native child, built wrapper | Codex tree, built wrapper |
| --- | ---: | ---: | ---: | ---: |
| 1 idle chat / 1 project | 488.9 [472.6–506.7] | 340.0 [313.6–341.3] | 173.5 [160.7–175.0] | 220.5 [207.6–222.0] |
| 5 idle chats / 1 project | 493.5 [478.3–560.6] | 343.5 [310.9–353.7] | 236.6 [178.3–245.7] | 283.9 [218.7–293.0] |
| 15 idle chats / 3 projects | 526.4 [487.9–530.5] | 350.5 [349.6–352.3] | 352.2 [290.1–359.6] | 400.1 [331.3–407.7] |
| 5 concurrent chats, active peak | 616.3 [513.4–662.4] | 391.7 [388.0–393.0] | 266.8 [259.1–288.2] | 309.8 [300.1–335.7] |

Built Mastra uses about **30–36% less RSS** than its contemporaneous tsx runs. It retains a larger one-chat/active footprint than native Codex; at 15 empty chats across three projects it is similar to the native Codex child. The Node comparison wrapper is not part of deployed app-server itself, so both native and total numbers are shown. Differences across fresh processes cannot be interpreted as precise incremental per-chat costs.

### Startup versus loaded-session growth

Separate no-model, single-project probe; median of three fresh processes, current-process RSS in MiB:

| Stage | Plain Node | tsx |
| --- | ---: | ---: |
| Node baseline | 12.4 | 22.8 |
| Full SDK imported | 306.4 | 591.1 |
| One project, zero chats | 310.4 | 592.8 |
| One chat | 310.9 | 593.1 |
| Five chats | 311.4 | 593.4 |
| Fifteen chats | 312.2 | 594.3 |

Most growth occurs at full SDK import, before project/chat creation. The separate three-project built probe reaches 315.2 MiB with no chats and 316.3 MiB with 15 empty chats. Normal heap-used measurements can fall as chats are added because garbage collection runs; do not infer negative per-chat cost.

The single forced-GC diagnostic per mode retained about **87.2 MiB of heap after built SDK import**, versus **238.2 MiB under tsx**; after 15 chats, about **90.1 versus 240.9 MiB**. RSS remained around 310 MiB for built code after 15 chats. This distinguishes loader-associated retained heap from a claim that all RSS is live JavaScript objects; forced GC is not a recommended runtime policy. We did not attribute the difference to individual dependencies, source maps, code caches or loader internals.

**Port decision:** use built code for production-like evaluation. The earlier 500–630 MiB observations overstated the plain-Node footprint. There is still fixed SDK/dependency/runtime overhead, but the data does not demonstrate a large per-empty-chat penalty, and does not justify a move to Core. This is not a controlled Rust-versus-TypeScript language comparison. Keep the native-first architecture and proceed with the chat slice; evaluate realistic long histories, tools/plugins and sustained multi-project activity as those integrations land. These short tests establish neither long-term memory stability nor a leak.

Validation: all 43 tests, TypeScript checks and build pass. Independent source and results review verified launch labeling, sample counts, correctness, arithmetic and interpretation limits.
