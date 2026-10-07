# Mastra Code SDK compatibility spike

Status: Complete — compatibility spike only; production migration gates remain open.

## Purpose and boundary

Validate Mastra Code SDK as the native runtime for a future TypeScript/oRPC Kodex gateway. This branch contains an isolated experiment, not a replacement gateway or a deployment. The current Rust gateway, React client, generated API contract, launchd service, and Codex storage remain operational. No existing conversations, credentials, or settings are imported.

Pinned baseline: `@mastra/code-sdk` 1.10.1, `@mastra/core` 1.74.0, `@mastra/memory` 1.35.0, `@mastra/libsql` 1.25.0, oRPC 1.15.4. Upstream release commit: `b21e46e19b469a25c8896bcee90afd58d6f1a890`. The spike package and lockfile are under `spikes/mastra-code-sdk`.

## Accepted product decisions

- Use full Mastra Code SDK, accepting its native defaults wherever possible. Prefer first-party components over custom orchestration or plugin forks.
- One Node process hosts multiple chats. A controller per project scopes SDK project integrations; each chat has a distinct native Session/resource identity. Browser tabs observing one chat share its Session. Historical reads should not activate work.
- Keep React/Vite; eventual backend uses TypeScript and oRPC. This spike does not change production API ownership or generated contracts.
- Fresh dedicated Kodex profile. ChatGPT subscription login is required. Provider login, plugin installation, and MCP setup are CLI/config workflows initially.
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

Compatibility implementation is in `spikes/mastra-code-sdk`; see its README for commands. Final validation: **16/16 tests pass**, `npm run check` passes (including unused-local/parameter checks), and independent review has no remaining findings blocking the spike scope. The final full suite completed in approximately 20 seconds with no `CLIENT_CLOSED` warnings. Earlier immediate teardown of unnamed live threads did reproduce those warnings; the production limitation below is not cleared by the final suite.

Two real authenticated model requests succeeded in separate processes using the same dedicated saved login. The final smoke reported 19,658 input tokens and 11 output tokens with the stock coding instructions/tools; this is a useful prompt-overhead observation, not an active-workload benchmark. No existing gateway, UI or installed service was changed or deployed.

Observed results on 2026-10-07:

- A real ChatGPT request succeeded through native OAuth with `openai/gpt-6.1-sol`. The account's native model catalog identified supported models after `gpt-5.4` and `gpt-5.3-codex` were rejected. A fresh process reused native credential storage without copying Codex credentials.
- Real SDK tests exercise concurrent project controllers, same-project Sessions, workspace file tools, independent settings/history, native goals continuing then completing, and persisted goal/history reads after recreation.
- Use native `Session.followUp()` for Queue. `Session.queueMessage()` inherits the current run's abort signal in this version; native `followUp()` already isolates it. A process crash loses waiting input while completed history/settings survive; reopening does not start a model request.
- Two actual oRPC HTTP/SSE consumers observe the same Session. Disconnect preserves execution; reconnect and slow consumers re-read native state. Cancellation and coalesced-text overlap regression tests use the real native Session event bus. These are transport checks, not browser UI validation.
- Native persistent schedules deliver into an active run, wake an unloaded idle chat, and fire from the calendar after runtime recreation. A small native `schedules.prepare` hook supplies Session context; no Kodex scheduler or queue store is required. Trigger outcome is an acknowledgment, not assistant completion.

The spike is not a production migration approval. Remaining integration gates:

1. Native `agent_end`/`sendMessage()` completion can precede trailing title/snapshot writes. `Mastra.shutdown()` closes SQLite without joining all standard-agent writes. Immediate teardown produced `CLIENT_CLOSED` warnings; there is no sleep, SDK patch or false drain guarantee in the spike. Resolve safe production shutdown/retirement before replacing the gateway.
2. `homeDir` does not cover all SDK global config discovery. MCP config and legacy database resource/scope lookup can use the real home. The experiment defaults MCP off, disables arbitrary hooks/plugins, uses a dedicated config-directory name and explicitly selects the native default thread memory scope. General plugin/MCP/profile isolation is not proven.
3. The snapshot revision covers observed native Session events, not database commit order. Unnotified late persistence is outside the fencing proof. A production transcript protocol needs a supported persistence-completion/read contract, pagination and load testing.

Subagent UI, custom widgets, MCP Apps, attachment flows, long-context observational memory, notification delivery and retained Kodex integrations remain outside this spike. Idle RSS figures above are preliminary; no production active-load benchmark has been completed.

## References

- [Code SDK source and public README](https://github.com/mastra-ai/mastra/tree/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk)
- [AgentController](https://mastra.ai/docs/harness/agent-controller)
- [Goals](https://mastra.ai/docs/harness/goals)
- [Schedules](https://mastra.ai/docs/harness/schedules)
- [Durable execution and recovery limits](https://mastra.ai/docs/harness/durable-agents)
