# App-server Live Config Refresh Plan

## Status

Complete.

## Scope

After the gateway is bumped to Codex app-server `0.130.0`, audit and implement the live config refresh behavior that lets loaded app-server threads pick up config changes without requiring restart, unload, or thread recreation.

This plan is intentionally separate from [Codex 0.130.0 Bump And Full Turn History Plan](app-server-full-turn-history.md). The history plan upgrades the runtime and fixes snapshots. This plan uses that upgraded runtime to simplify and improve settings/config behavior.

## Current Repo Grounding

Relevant gateway surfaces:

- `apps/gateway/src/app_server_api.rs`
  - `composer_settings` reads app-server `config/read`.
  - `update_composer_settings` writes `config/batchWrite` but currently omits `reloadUserConfig`.
  - MCP add/replace/enable/remove routes use `config_batch_write`, which does send `reloadUserConfig: true`.
  - `mcp_reload` calls `config/mcpServer/reload`.
- `apps/gateway/src/routes/composer_settings.rs`
  - `GET /v1/composer-settings` reads global or project-scoped config.
  - `PATCH /v1/composer-settings` persists model, effort, and service tier defaults.
  - Settings writes broadcast skill invalidation only for model, effort, and service tier changes.
- `apps/gateway/src/routes/threads.rs`
  - `apply_thread_composer_settings`, `overlay_stored_thread_composer_settings`, and `save_forked_thread_composer_settings` overlay gateway SQLite settings onto app-server thread summaries.
  - This was added to make create/resume/read/list coherent when app-server did not persist or refresh every setting.
- `apps/gateway/src/store.rs`
  - `thread_composer_settings` stores gateway-owned per-thread model, reasoning effort, service tier, approval policy, approvals reviewer, and sandbox.
- `apps/gateway/src/automations.rs`
  - `latest_thread_options` uses `thread_composer_settings` to decide turn options for automation-generated prompts.
- `apps/web/src/composer/useComposerSettingsState.ts`
  - Draft settings remain local.
  - Existing selected threads can temporarily use `selectedThreadComposerOverride` after a user changes controls.
  - Persisted defaults are hydrated through TanStack Query from `/v1/composer-settings`.
- `apps/web/src/composer/settings.ts`
  - Existing-thread composer controls derive settings from `ThreadSummary` and `rawPayload`.

## Goal

Make app-server live config the source of truth wherever `0.130.0` supports it, and remove or narrow gateway/browser settings overlays that only exist to compensate for stale loaded-thread config.

The desired end state is:

- Config writes that should affect loaded threads request app-server reload/refresh behavior.
- Existing-thread composer settings come from app-server thread/config state after refresh, not from stale gateway SQLite overlays.
- Gateway-owned state remains only where it represents real Kodex policy not owned by app-server, or where app-server still lacks a durable contract.
- Multi-tab behavior converges through gateway/app-server state, not through one browser tab's local override.

## Audit Result

| Surface | Result |
| --- | --- |
| Global/project composer defaults | App-server `config/read` remains the source of truth. Gateway composer writes now use `config/batchWrite` with `reloadUserConfig: true`, matching the `0.130.0` schema description for hot-reloading updated user config into loaded threads. |
| MCP config mutations | Already used reload-aware `config_batch_write`; retained and verified. |
| Selected-thread metadata | App-server-returned thread fields now win over gateway SQLite overlays. Gateway `thread_composer_settings` only fills fields app-server omits. |
| Create/turn-start response coherence | Gateway still saves submitted settings as fallback state because app-server responses can omit fields immediately after commands. |
| Forked threads | Gateway still copies fallback settings only for fields app-server omits on later reads/lists. |
| Automations | Retain gateway-stored per-thread settings for now. Changing automations to mutable global/project defaults remains a product decision outside this implementation. |
| Frontend settings cache | Successful composer settings writes now invalidate composer-settings and model queries after optimistic cache update. Existing-thread local overrides remain temporary UI state and reset when server thread metadata changes. |

## Milestone 1: Contract And Behavior Audit

Failing or characterization tests first:

- Gateway adapter test showing composer settings `config/batchWrite` should include the `0.130.0` reload/refresh flag needed for loaded threads.
- Gateway route test showing MCP config writes and composer config writes use consistent reload semantics where appropriate.
- Gateway route test capturing current behavior for a selected loaded thread after config defaults change.
- Frontend test capturing whether `selectedThreadComposerOverride` can mask refreshed server thread metadata.

Implementation:

- Inspect regenerated `0.130.0` schemas for `config/read`, `config/batchWrite`, `thread/read`, `thread/resume`, `turn/start`, MCP config reload, permissions profile fields, and any config-refresh notifications.
- Verify upstream README wording for live thread config refresh and config write semantics.
- Classify each setting surface:
  - Global/project defaults from `config/read`.
  - Per-thread execution metadata from app-server `Thread`.
  - Runtime-loaded thread config that refreshes after config writes.
  - Gateway-only policy/state that should remain in SQLite.
- Decide, based on tests and schema behavior, whether `thread_composer_settings` is still needed for each field.

Exit conditions:

- The plan has a concrete field-by-field migration table before implementation proceeds.
- Tests identify stale loaded-thread behavior that `0.130.0` live refresh can fix.
- Any settings that app-server still does not own are explicitly kept in gateway state.

## Milestone 2: Make Gateway Config Writes Refresh Loaded Threads

Failing tests first:

- `update_composer_settings` sends `reloadUserConfig: true` or the `0.130.0` equivalent when it writes config.
- Composer settings writes invalidate affected frontend Query caches and skill/model surfaces predictably.
- MCP config mutation tests still pass and do not double-reload unnecessarily.

Implementation:

- Route composer settings writes through the same reload-aware helper as MCP writes, or add a shared `config_batch_write(edits, reload_user_config)` helper.
- Keep no-op writes no-op.
- Preserve skill invalidation for changes that affect skill/model behavior.
- If `0.130.0` introduces a stronger app-server notification for config changes, normalize and broadcast it through the existing SSE/query invalidation path instead of inventing a browser-local signal.

Exit conditions:

- Loaded app-server threads can observe updated config on subsequent turns without restarting gateway or app-server.
- Focused gateway adapter and route tests pass.
- README is updated if the user-visible reload behavior changes.

## Milestone 3: Simplify Thread Settings Overlays

Failing tests first:

- Existing-thread composer controls update from refreshed app-server `ThreadSummary` data after config changes.
- Switching between two threads cannot preserve stale `selectedThreadComposerOverride` once a newer server snapshot arrives.
- Automation-generated prompts use app-server-owned refreshed settings or an intentionally retained gateway-owned field, not stale copied settings.
- Forked threads do not copy gateway-owned settings that app-server now persists natively.

Implementation:

- Reduce `apply_thread_composer_settings` and `overlay_stored_thread_composer_settings` field by field where `0.130.0` app-server now returns durable, refreshed values.
- Remove or narrow `save_forked_thread_composer_settings` once fork responses carry the correct app-server metadata.
- Rework `automations::latest_thread_options` so automations read canonical app-server thread/config state when practical; retain gateway store reads only for fields app-server does not expose.
- Keep create-response overlays only for immediate response coherence if app-server command responses still omit fields that were just submitted.

Exit conditions:

- Gateway SQLite is no longer the default authority for settings that app-server owns and refreshes.
- Existing-thread settings remain correct across reload, fork, automation run, and two browser tabs.
- Backend tests document any retained gateway-owned settings.

## Milestone 4: Frontend Cache And Multi-Client Convergence

Failing tests first:

- A selected-thread snapshot refresh replaces a local `selectedThreadComposerOverride` when it carries newer server settings.
- Composer defaults query invalidates/refetches after successful settings writes.
- Two simulated browser clients converge after one changes defaults/settings and the other receives refreshed gateway/app-server state.

Implementation:

- Tighten `useComposerSettingsState` so local overrides are temporary UI state only until the server snapshot or defaults query catches up.
- Use existing Query keys in `apps/web/src/api/queryKeys.ts` for composer settings, models, selected thread detail, and thread lists.
- Do not introduce browser persistence for existing-thread settings.
- Keep draft composer settings local-only.

Exit conditions:

- Existing-thread controls reflect server state after refresh.
- Draft composer settings remain local and unaffected by thread refreshes.
- Focused composer settings tests pass.

## Milestone 5: Browser And Runtime Verification

Verification:

- Run focused gateway tests around app-server config writes, thread settings overlays, automations, and MCP config routes.
- Run focused frontend composer settings tests.
- Run `cd apps/web && npm run build`.
- Start fullstack dev.
- Use agent-browser to:
  - Open an existing loaded thread.
  - Change composer defaults/settings through the UI.
  - Start or steer another turn without restarting app-server.
  - Verify the loaded thread uses refreshed settings and both browser tabs converge.

Exit conditions:

- No restart/reload workaround is required for live config changes that app-server `0.130.0` supports.
- Any remaining gateway-owned settings behavior is documented as intentional.
- Independent review finds no regression in server-owned thread settings or MCP config management.

## Completion Notes

- `CodexClient::update_composer_settings` now routes writes through the reload-aware config writer.
- Gateway stored thread settings are fill-only overlays, so refreshed app-server thread metadata is authoritative when present.
- Frontend composer settings writes invalidate relevant Query caches after a successful save.
- Focused backend tests cover reload-aware composer writes and fill-only settings overlays.
- Focused frontend tests cover composer settings cache refetching plus two mounted clients replacing stale local thread-setting overrides from refreshed server metadata.
- Runtime browser mutation of live config was not performed because it would require a real loaded app-server thread and model turn in the local user environment. The implemented contract is the app-server `reloadUserConfig:true` write plus browser convergence through refreshed gateway/app-server thread metadata.

## Open Questions For Implementation

- Does app-server return refreshed per-thread permission/profile metadata for already-loaded threads, or only global defaults for future turns?
- Should automations inherit mutable global/project defaults, immutable thread-start settings, or current app-server thread settings? The current gateway behavior uses saved per-thread settings; do not change that policy without an explicit test and product decision.
