# Mastra Code SDK compatibility spike

Status: Complete — compatibility spike only; production migration gates remain open.

## Purpose and boundary

Validate Mastra Code SDK as the native runtime for a future TypeScript/oRPC Kodex gateway. This branch contains an isolated experiment, not a replacement gateway or a deployment. The current Rust gateway, React client, generated API contract, launchd service, and Codex storage remain operational. No existing conversations, credentials, or settings are imported.

Pinned baseline: `@mastra/code-sdk` 1.10.1, `@mastra/core` 1.74.0, `@mastra/memory` 1.35.0, `@mastra/libsql` 1.25.0, oRPC 1.15.4. Upstream release commit: `b21e46e19b469a25c8896bcee90afd58d6f1a890`. The spike package and lockfile are under `spikes/mastra-code-sdk`.

## Accepted product decisions

- Use full Mastra Code SDK, accepting its native defaults wherever possible. Prefer first-party components over custom orchestration or plugin forks.
- One Node process hosts multiple chats. A controller per project scopes SDK project integrations; each chat has a distinct native Session/resource identity. Browser tabs observing one chat share its Session. Historical reads should not activate work.
- Keep React/Vite; eventual backend uses TypeScript and oRPC. This spike does not change production API ownership or generated contracts.
- Fresh dedicated Kodex profile. ChatGPT subscription login is required. Provider login and MCP setup are CLI/config workflows initially. Arbitrary plugins are explicitly deferred by the 2026-10-09 user decision; this supersedes the earlier CLI plugin-installation plan.
- No sandbox or added approval layer. Trusted local/VPN use only.
- Native queue: waiting input may be lost on backend restart. Stop interrupts current work; queued input may proceed. No Kodex durable queue or pause/drain state machine.
- Standard execution: interrupted runs require explicit user continuation after restart. Do not enable experimental durable/evented recovery.
- Native goals and judge behavior. Effectively unlimited evaluation budget via `Number.MAX_SAFE_INTEGER`; the native API has a numeric cap rather than a literal unlimited setting. No token budget initially. Completion, native waiting checkpoints, errors, and manual interruption still apply.
- Native observational memory defaults.
- Subagents: live text/tool/status inspection and persisted final results. No messaging/stop UI and no custom durable full-child transcript store.
- Persistent `mastra.schedules` calendar schedules (not Code SDK's process-local `/schedules` helper). Scheduled prompts join an active conversation; idle targets may be awakened by the schedule.
- Standard extension dialogs/notifications; leave a future browser-widget seam. Defer MCP Apps initially.
- Preserve Kodex-specific product workflows for the eventual migration: projects/pins/read markers, automations, integrated terminal, file/generated app panes, Control tools, docking, notifications/PWA. Their implementation is outside this spike.

## Proofs and exit conditions

1. **Profile and login:** an explicit dedicated profile feeds native auth/settings/storage; CLI ChatGPT login and a real authenticated minimal request work. A fresh process can use the saved login. Credentials and OAuth responses must never appear in reports.
2. **Concurrent runtime:** two project controllers and multiple chat Sessions run in one process. Cwd, session events, messages, and interruption are scoped; stopping A does not stop B. Use deterministic provider responses to test lifecycle without model variability.
3. **Native behavior:** exercise queued input and Stop, goal settings persistence, and restart boundaries. History/settings survive, pending queue does not; no implicit model continuation on reopening.
4. **Client convergence:** two independent oRPC/SSE consumers attach to one native Session; disconnecting one does not abort the run; reconnect starts from a current native snapshot. Validate transport behavior, not the existing browser renderer.
5. **Scheduling:** native persistent schedules survive runtime recreation, target the intended chat, and deliver during an active run using native signal semantics. Distinguish schedule creation, fire acknowledgment and completed execution.
6. **Review:** typecheck, focused tests and independent review pass. Record observed limitations and any unproven external-login steps. Do not mark the milestone complete while required proofs remain pending.

Deterministic provider fixtures are test doubles only for the remote model. Tests must use the real published SDK for sessions, native execution, tools, persistence, subscriptions and scheduling. Live model checks are small explicit prompts against a disposable project. No public listener, production restart or deployment is authorized by this spike.

## Initial evidence

Earlier disposable idle benchmarks on the local M4 measured one/five empty chats at approximately 338/339 MiB with Code SDK, 174/174 MiB with core plus a smaller coding setup, 130–152/670 MiB for process-per-chat Pi, and 74–88/95–102 MiB for Codex app-server. Code SDK with twenty chats used about 340 MiB. RSS includes shared pages; these are idle, single-project samples, not active workload or multi-project-controller sizing guarantees.

Source audit found the interactive queue is process-local even with durable wrappers. Durable workflow recovery is a separate beta feature that can replay model/tool calls; it is unnecessary under the accepted restart behavior. The local Code SDK `wireSessionConcerns` convenience helper has active-session assumptions; use server/native Session APIs instead. Default provider state is shared within a process, appropriate for one dedicated local account profile. Disable project `.env` loading into the shared process.

## Results

Compatibility implementation is in `spikes/mastra-code-sdk`; see its README for commands. Initial validation: **16/16 tests pass**, `npm run check` passes (including unused-local/parameter checks), and independent review has no remaining findings blocking the spike scope. The final full suite completed in approximately 20 seconds with no `CLIENT_CLOSED` warnings. Earlier immediate teardown of unnamed live threads did reproduce those warnings; the production limitation below is not cleared by the final suite.

Two real authenticated model requests succeeded in separate processes using the same dedicated saved login. The final smoke reported 19,658 input tokens and 11 output tokens with the stock coding instructions/tools; this is a useful prompt-overhead observation, not an active-workload benchmark. No existing gateway, UI or installed service was changed or deployed.

Observed results on 2026-10-07:

- A real ChatGPT request succeeded through native OAuth with `openai/gpt-6.1-sol`. The account's native model catalog identified supported models after `gpt-5.4` and `gpt-5.3-codex` were rejected. A fresh process reused native credential storage without copying Codex credentials.
- Real SDK tests exercise concurrent project controllers, same-project Sessions, workspace file tools, independent settings/history, native goals continuing then completing, and persisted goal/history reads after recreation.
- Use native `Session.followUp()` for Queue. `Session.queueMessage()` inherits the current run's abort signal in this version; native `followUp()` already isolates it. A process crash loses waiting input while completed history/settings survive; reopening does not start a model request.
- Two actual oRPC HTTP/SSE consumers observe the same Session. Disconnect preserves execution; reconnect and slow consumers re-read native state. Cancellation and coalesced-text overlap regression tests use the real native Session event bus. These are transport checks, not browser UI validation.
- Native persistent schedules deliver into an active run, wake an unloaded idle chat, and fire from the calendar after runtime recreation. A small native `schedules.prepare` hook supplies Session context; no Kodex scheduler or queue store is required. Trigger outcome is an acknowledgment, not assistant completion.

The spike is not a production migration approval. Remaining integration gates:

1. Native `agent_end`/`sendMessage()` completion can precede trailing title/snapshot writes. `Mastra.shutdown()` closes SQLite without joining all standard-agent writes. Immediate teardown produced `CLIENT_CLOSED` warnings; there is no sleep, SDK patch or false drain guarantee in the spike. The focused native shutdown audit below narrows the demonstrated failure; it does not establish normal completed-answer loss.
2. `homeDir` does not cover all SDK global config discovery. MCP config and legacy database resource/scope lookup can use the real home. The experiment defaults MCP off, disables arbitrary hooks/plugins, uses a dedicated config-directory name and explicitly selects the native default thread memory scope. General plugin/MCP/profile isolation is not proven.
3. The snapshot revision covers observed native Session events, not database commit order. Unnotified late persistence is outside the fencing proof. A production transcript protocol needs a supported persistence-completion/read contract, pagination and load testing.

Subagent UI, custom widgets, MCP Apps, attachment flows, long-context observational memory, notification delivery and retained Kodex integrations remain outside this spike. Idle RSS figures above are preliminary; no production active-load benchmark has been completed.

## Native shutdown audit (2026-10-07)

Follow-up validation: **17/17 tests and typecheck pass**, including the shutdown characterization; independent review found no issues in the new proof. Its expected native closed-store diagnostics reproduce the gap rather than fix it.

The spike already calls native `Mastra.shutdown()`. In an embedded Node host, normal `SIGINT`/`SIGTERM` handlers should invoke the host cleanup path; a completed turn is not a reason to shut down the backend.

| Native API / signal | What it establishes | Limit for this spike |
| --- | --- | --- |
| `Mastra.shutdown({ drainTimeout })` | Native component cleanup; bounded draining of tracked evented workflows/durable agents before workers/storage close | Standard-run detached title jobs are not tracked by this drain |
| `Memory.settled()` | That Memory instance's observational-memory cycles and deletion vector cleanup have settled | Does not join Agent-owned automatic title generation |
| `Session.sendMessage()` / `agent_end` | Foreground native run completion | Detached title work can remain |
| `Session.sendMessage({ untilIdle: true })` | Includes native background-tool continuation handling | Not a general database-write/title flush |
| `thread_title_updated` | A particular generated title has been saved successfully | No all-background-work completion/failure barrier |
| Native memory `generateTitle.emitEvent: true` | Delays normal stream completion until title persistence | Changes completion latency; abort still releases the stream while the title continues; not enabled by CodeSDK default memory |
| Direct Agent `serverless.waitUntil` | Exposes detached title work to a platform lifetime callback | CodeSDK's high-level Session send API does not expose/forward it; not a ready-made Session shutdown drain |

A deterministic published-SDK test (`test/shutdown.test.ts`) holds only the title model response. The foreground assistant answer is already persisted and the Session is idle. `Memory.settled()` and `Mastra.shutdown({ drainTimeout: 30_000 })` both return before that title response is released. The released title then hits `CLIENT_CLOSED`; reopening the same native store confirms the completed assistant answer survives. Nested title-agent workflow cleanup also logs expected closed-store warnings. This test characterizes the pinned native limitation; passing it does not mean shutdown has been fixed.

The [corresponding native Mastra Code CLI](https://cdn.jsdelivr.net/npm/mastracode@0.44.1/dist/cli.js) (`mastracode` 0.44.1) also uses bounded process-exit cleanup and calls native shutdown; it does not provide an additional universal standard-Session drain. The observed concern is narrower than the initial broad persistence gate: interrupted automatic title generation/internal cleanup at shutdown, not demonstrated loss of normally completed conversations. No custom queue, transcript store, sleeps, SDK patch, or production lifecycle change was added. Existing `Memory.settled()` and native shutdown remain the integration path. Failure/abort persistence and arbitrary tool subprocess retirement are separate unproven cases; do not infer their safety from the completed-answer proof.

Sources: installed exact-version public declarations and runtime source; [native shutdown drain implementation and scope](https://github.com/mastra-ai/mastra/pull/23168), [Mastra class reference](https://mastra.ai/reference/core/mastra-class). The upstream drain fix explicitly concerns evented workflows/durable agents, which the spike deliberately does not enable.

## References

- [Code SDK source and public README](https://github.com/mastra-ai/mastra/tree/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk)
- [AgentController](https://mastra.ai/docs/harness/agent-controller)
- [Goals](https://mastra.ai/docs/harness/goals)
- [Schedules](https://mastra.ai/docs/harness/schedules)
- [Durable execution and recovery limits](https://mastra.ai/docs/harness/durable-agents)
