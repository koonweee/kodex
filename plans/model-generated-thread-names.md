# Model Generated Thread Names

## Context

- Kodex should generate a succinct thread name after the first user turn when app-server does not provide one.
- Direct app-server probing on `codex-cli 0.135.0` showed `thread/start`, `thread/started`, and first-turn completion leave `thread.name` as `null`; app-server only exposes explicit `thread/name/set`.
- The gateway already owns first-turn submission through `apps/gateway/src/routes/turns.rs` and thread rename through `apps/gateway/src/routes/threads.rs`.
- `codex exec` provides a lighter one-shot model path than spawning a helper app-server: `--ephemeral`, `--ignore-rules`, `--ignore-user-config`, `--output-schema`, `--output-last-message`, `--cd`, and `-m`.

## Current State

- `submit_thread_input` and `start_turn` call `turn_start_resuming_missing_thread_once` in `apps/gateway/src/routes/turns.rs`.
- `CodexClient::thread_set_name` in `apps/gateway/src/app_server_api.rs` wraps app-server `thread/name/set`.
- Frontend cache convergence already handles `thread/name/updated` through `apps/web/src/threads/events.ts` and `apps/web/src/threads/useThreadMetadata.ts`.
- Public API/OpenAPI changes are not required if title generation remains gateway-internal.
- Contributor guidance requires behavior-changing work to start with focused failing tests when practical and to keep shared thread state gateway-owned.

## Milestones

### 1. Title Generation Service

- Scope: `apps/gateway/src/title_generation.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/main.rs` module wiring as needed.
- Work:
  - Add an in-memory per-thread job registry that suppresses duplicate generation while a job is running or has already completed in this gateway process.
  - Extract first-user text from `Vec<UserInput>` without resolving images or non-text inputs into the title prompt.
  - Spawn `codex exec` with:
    - `--ephemeral`
    - `--ignore-rules`
    - `--ignore-user-config`
    - `--skip-git-repo-check`
    - `--cd /private/tmp`
    - `--sandbox read-only`
    - `-m gpt-5.4-mini`
    - `-c model_reasoning_effort="medium"`
    - `--output-schema <temp-schema>`
    - `--output-last-message <temp-output>`
    - stdin prompt input
  - Parse, normalize, and validate the generated title.
  - Before applying a generated title, re-read the original app-server thread and skip if `thread.name` is already non-empty.
  - Apply valid generated titles with app-server `thread/name/set` so existing SSE convergence handles updates.
- Exit criteria:
  - Focused unit tests cover duplicate suppression, prompt input extraction, title normalization, user-rename-wins behavior, command construction, timeout/failure cleanup, and successful `thread/name/set`.

### 2. First-Turn Trigger Integration

- Scope: `apps/gateway/src/routes/turns.rs`, route tests in `apps/gateway/src/routes/mod.rs` or a closer test module.
- Work:
  - Trigger title generation only after a real turn successfully starts.
  - Trigger only when the thread is currently unnamed and the submitted input has usable text.
  - Keep title generation best-effort and non-blocking; turn submission response latency must not wait for title generation.
  - Ensure queued inputs, active-turn steers, and explicit `start_turn` flows do not create duplicate jobs for the same first request.
- Exit criteria:
  - Route tests prove unnamed first input schedules generation, named threads do not, queued inputs do not start jobs immediately, and duplicate submissions are suppressed.

### 3. Verification And Documentation

- Scope: backend tests and plan index.
- Work:
  - Keep `plans/index.md` status accurate while implementation is active and complete when exit criteria pass.
  - Run `cargo fmt`.
  - Run focused gateway tests for title generation and turn submission behavior.
  - Run broader backend tests if focused changes touch shared app-server client or route state.
- Exit criteria:
  - Focused tests pass.
  - Independent review finds no major issues.
  - No frontend generated API artifacts are changed for this internal behavior.

## Verification

- `cargo fmt`
- `cargo test -p kodex-gateway title_generation`
- Focused route tests matching the final test names, for example `cargo test -p kodex-gateway schedules_thread_title_generation`
- Broader `cargo test -p kodex-gateway` if shared route/app-server code changes beyond the title generator and turn trigger.

## Risks And Open Questions

- `codex exec` is an external process and model call. The gateway must bound runtime with a timeout and treat failures as non-fatal.
- `--ignore-user-config` keeps auth but avoids user config; if a deployment depends on custom provider config for model routing, title generation may fail. The first implementation should log and skip rather than falling back to user config.
- The exact model id is `gpt-5.4-mini` by product decision. If installed Codex later rejects that model id, failures remain best-effort and visible only in logs.
