# Skill Shortcut Composer Plan

## Status

Complete.

## Goal

Support Codex-style `$skill-name` invocation from the Kodex web composer with autocomplete, keyboard navigation, and structured skill enrichment, while keeping gateway/app-server state authoritative enough to avoid frontend desync.

## Non-Goals

- Do not build a full skills management UI in this plan. Enable/disable support is considered only for cache invalidation and future route shape.
- Do not add app mentions or plugin mentions unless the skill implementation naturally creates a reusable mention model.
- Do not make browser-local skill catalogs durable. Browser state is autocomplete convenience only.
- Do not bypass the checked-in app-server schema. Gateway requests to app-server must still validate against `apps/gateway/app-server-schema/0.128.0`.

## Current Kodex Grounding

- `apps/gateway/src/app_server_api.rs` already defines `UserInput::Skill { name, path }` and `UserInput::Mention { name, path }` alongside text and image inputs.
- `apps/web/src/api/generated/schema.ts` already exposes the generated `UserInput` union with `type: "skill"` and `type: "mention"`.
- `apps/web/src/composer/useComposerOrchestration.ts` currently builds only text and image user inputs in the send path.
- `apps/web/src/composer/ComposerPanel.tsx` uses a Mantine `Textarea`, so the first implementation should use plain `$name` text plus popup/binding state. Inline rich chips require a later editor replacement or overlay.
- `apps/gateway/src/routes/turns.rs` and `apps/gateway/src/queue.rs` currently trust incoming `Vec<UserInput>` and pass queued rows through unchanged.
- `apps/gateway/src/events.rs` stores app-server notifications as `codex.notification`, but live/replay filtering does not currently surface global `skills/changed` to the frontend.
- `apps/gateway/app-server-schema/0.128.0/json/v2/SkillsListParams.json`, `SkillsListResponse.json`, `SkillsConfigWriteParams.json`, and `SkillsChangedNotification.json` are checked in, but the gateway has no typed skill routes or `CodexClient` helpers yet.
- `ThreadSummary.cwd` and `Project.cwd` are already available in generated frontend types, so the web app can choose an active composer cwd without asking the browser to infer filesystem context.

## Upstream Codex Cross-Reference

Use the app-server README and checked-in schemas as the contract. Use the TUI as client behavior guidance.

- App-server skills contract: `skills/list` accepts `cwds`, `forceReload`, and optional per-cwd extra user roots; responses are grouped by cwd; clients should include both text containing `$skill-name` and a structured `skill` input item for low-latency invocation. Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#skills
- `skills/changed` is an invalidation notification for watched local skill file changes; its payload is empty, so clients must re-run `skills/list` with their current params. Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/skills_watcher.rs
- TUI maps `SkillsListResponse` to its current cwd, keeps all skills for management, and exposes only enabled skills to mention autocomplete. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/skills.rs
- TUI parses both raw `$name` mentions and linked mention bindings, ignores common environment variables like `$PATH`, and resolves path-linked mentions before name matches. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/skills.rs
- TUI autocomplete uses `MentionItem` with display name, description, insert text, search terms, path, category tag, and sort rank; filtering prefers display-name fuzzy matches, then secondary search terms, then rank/name. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/skill_popup.rs
- TUI composer refreshes mention popups when skill mentions are replaced, and keeps mention bindings separate from visible text until submit. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer.rs
- App-server `skills/config/write` clears app-server skill/plugin caches after enablement changes, but clients should not depend on a `skills/changed` notification for command-originated config changes. Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/catalog_processor.rs
- Generic app-server config writes clear skill/plugin caches as well, so future Kodex config/plugin mutation routes must invalidate the gateway skill cache after successful writes. Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/config_processor.rs

## UX Contract

- Typing `$` opens a popup anchored to the composer.
- Typing after `$` filters skills by display name, skill name, and short description terms.
- `Enter` or `Tab` inserts the selected skill as `$skill-name` plus a trailing space when appropriate.
- `Esc` closes the popup without deleting text.
- Arrow keys move selection; mouse click selects a row.
- Rows show display name, `$skill-name`, scope badge, and a concise description. Disabled skills are omitted from invocation autocomplete, matching TUI behavior.
- If the catalog is loading, show a compact loading row. If no skills match, show `No matching skills`.
- If the catalog was invalidated while the popup is open, refresh in place and keep the typed query.
- Manually typed `$foo` stays plain text if it cannot be resolved. Autocompleted stale selections fail clearly at submit instead of silently invoking a wrong skill.
- Because the current composer is a `Textarea`, selected skills initially remain plain text. The composer should maintain hidden mention bindings keyed by the inserted token/range. A later rich-editor milestone can render inline chips without changing the gateway contract.

## Ownership Model

- App-server owns skill discovery and enablement semantics.
- Gateway owns the canonical per-cwd skill catalog projection used by Kodex and resolves skill mentions at submit/queue-dispatch boundaries.
- Frontend owns only ephemeral autocomplete UI state and selected mention candidates.
- Frontend may send proposed `skill` inputs for selected autocomplete items, but the gateway must validate and rewrite them from its current catalog before forwarding to app-server.
- Gateway must never forward a frontend-provided skill path unless the path still matches an enabled skill in the current app-server catalog for the relevant cwd.

## Active Cwd Rules

- Existing selected thread: use `selectedThread.cwd`.
- Draft project thread: use `selectedProject.cwd` or the draft project selector's project cwd.
- Draft chat: use a gateway default/global skill catalog for autocomplete because the final dated chat cwd does not exist until `createChatThread`. After materialization, gateway resolves against the created thread cwd before `turn/start`.
- Queued input: resolve against the target thread cwd, not the currently selected browser cwd.

## Milestone 1: Gateway Skill Catalog API

Acceptance criteria:

- Add typed app-server helpers in `apps/gateway/src/app_server_api.rs` for `skills/list` and the response DTOs needed by the web UI.
- Add a focused gateway route module, for example `apps/gateway/src/routes/skills.rs`.
- Add `GET /v1/skills?cwd=...&forceReload=...` returning enabled and disabled skill metadata plus errors for that cwd.
- Add OpenAPI schemas for the gateway skill catalog response and regenerate `apps/web/src/api/generated/schema.ts`.
- Add an in-memory gateway cache keyed by cwd with an invalidation generation. Do not persist this cache in SQLite.
- Normal requests use `forceReload=false`; requests after invalidation or explicit refresh use `forceReload=true`.

Implementation notes:

- `skills/list` can accept multiple `cwds`, but the first web route should return one active cwd to keep frontend behavior simple.
- Cache entries should preserve app-server errors so the popup can show a non-blocking warning without hiding valid skills.
- Use checked-in schema validation through the existing `CodexClient::request` path.

Tests:

- Gateway route test maps `/v1/skills` to app-server `skills/list` with the expected `cwds` and `forceReload`.
- Response parsing covers `enabled`, `scope`, `interface.displayName`, `interface.shortDescription`, `interface.defaultPrompt`, `path`, and `errors`.
- OpenAPI includes the new route and schemas.

## Milestone 2: Gateway Invalidation Lifecycle

Acceptance criteria:

- App-server `skills/changed` causes the gateway to invalidate all cached skill catalogs.
- Gateway emits a live `skills.changed` event over `/v1/events`.
- Frontend SSE recognizes `skills.changed`.
- Future gateway routes that call `skills/config/write`, plugin install/uninstall, marketplace add/remove/upgrade, or generic app-server config writes must invalidate the skill cache after successful writes.

Implementation notes:

- `skills/changed` has no cwd/path/change type, so invalidate globally.
- Current Kodex does not expose skill config/plugin mutation routes yet. Add helper methods and comments/tests where practical so future routes call the same invalidation function.
- Do not depend on app-server `skills/changed` for enable/disable or config writes. Treat command success as the invalidation signal.

Tests:

- `ingest_inbound` with `codex_method = "skills/changed"` appends and broadcasts a `skills.changed` event.
- A client connected to `/v1/events` receives the event even though it has no thread id.
- A stale cache entry is force-reloaded on the next skill list request after invalidation.

## Milestone 3: Gateway Submit-Time Resolver

Acceptance criteria:

- Gateway parses text inputs for `$name` tokens using TUI-compatible characters: letters, numbers, `_`, and `-`.
- Gateway ignores common environment variable tokens such as `$PATH`, `$HOME`, `$USER`, `$SHELL`, `$PWD`, `$TMPDIR`, `$TEMP`, `$TMP`, `$LANG`, `$TERM`, and `$XDG_CONFIG_HOME`.
- Gateway validates candidate `skill` inputs supplied by the frontend against the current enabled catalog.
- Gateway enriches selected or uniquely resolved skills by forwarding canonical `{ type: "skill", name, path }` items alongside the text input.
- Gateway blocks selected/autocompleted skill candidates that are no longer valid and returns a clear `400` error.
- Gateway leaves manually typed unresolved `$name` tokens as plain text without adding structured skill input.
- Gateway deduplicates skills by path first, then name, matching TUI behavior.

Implementation notes:

- Add a pure resolver module, for example `apps/gateway/src/skills.rs`, so route and queue paths share one implementation.
- `start_turn`, `steer_turn`, queued input creation, queued steer, and idle queue drain should all resolve or revalidate before sending to app-server.
- For queued rows, store the user's text and candidate structured inputs, but revalidate before dispatch. If a selected skill became invalid, mark the queued row failed instead of silently dropping the structured skill.
- Resolve cwd inside the gateway from `thread/read` for existing threads when needed. Draft thread creation already returns/materializes a thread before `turn/start`.

Tests:

- Selected skill path from frontend is rewritten from the gateway catalog before app-server forwarding.
- Stale selected skill path fails with a clear error.
- Manual unresolved `$not-installed` forwards only text.
- `$PATH` does not produce a skill lookup.
- Duplicate `$skill` tokens produce one structured skill item.
- Queued input created in one tab and drained later resolves against the queued thread cwd, not the selected thread in another tab.

## Milestone 4: Frontend Autocomplete and Enrichment

Acceptance criteria:

- Add generated-client wrappers in `apps/web/src/api/client.ts` for the gateway skills route.
- Add composer-domain helpers under `apps/web/src/composer`, for example:
  - `skillMentions.ts` for `$` token detection, mention binding maintenance, and filtering.
  - `SkillMentionPopup.tsx` for the popup presentation and keyboard actions.
  - `useSkillCatalog.ts` for ephemeral frontend catalog state keyed by active cwd and invalidation generation.
- `ComposerPanel` opens the popup when the cursor is in a `$` token.
- Selecting a row inserts/replaces the current token with `$skill-name` and records the candidate `{ name, path }` binding.
- `useComposerOrchestration` includes candidate `skill` inputs in the submitted `UserInput[]` after the text input.
- On `skills.changed`, the frontend invalidates its local catalog projection and refreshes if the popup is open.
- Draft text remains local to `ComposerPanel`, preserving the current low-rerender typing path.

Implementation notes:

- Keep `App.tsx` as a coordinator: compute/pass `composerCwd`, event invalidation generation, and API callbacks, but keep parser/popup behavior in the composer module.
- With `Textarea`, exact popup anchoring to caret can be approximate in the first pass. Anchor to the composer top or textarea bounds with stable responsive constraints.
- Maintain bindings defensively: if text edits delete or alter a bound `$skill`, drop that binding and let gateway resolve any remaining manual token.

Tests:

- Parser unit tests cover token detection, env-var exclusion, replacement ranges, and binding invalidation after edits.
- Component tests cover `$` opening, filtering, keyboard selection, `Esc`, no matches, and submit payload enrichment.
- Event stream tests cover `skills.changed`.
- Existing composer tests still pass, including draft locality and queued steer behavior.

## Milestone 5: Multi-Client and Lifecycle Verification

Acceptance criteria:

- Two browser clients connected to the same gateway converge when app-server emits `skills/changed`.
- One tab can open autocomplete, another tab can trigger a gateway skill/config/plugin invalidation, and the first tab refreshes before submitting a selected stale skill.
- A queued row created in one tab and dispatched later uses gateway/app-server-current skill validity.
- Frontend cache misses and stale catalogs degrade to refresh, not incorrect invocation.

Tests:

- Backend integration test for global `skills.changed` SSE delivery and cache invalidation.
- Frontend test with two stream clients or a shell-level test that simulates two listeners.
- Existing focused suites:
  - `cargo test`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`

## Ideal Future UX

- Replace the plain `Textarea` with a composer editor that can render selected skills as inline chips while preserving plain text output.
- Add a skills management popup using `skills/config/write`, with gateway-owned invalidation after each successful toggle.
- Merge skills and app mentions into one `$` mention framework once app mentions are in scope.
- Use skill `interface.defaultPrompt` for an optional quick-fill action, not automatic prompt insertion.

## Open Questions

- For draft chat autocomplete, should the gateway use app-server default cwd, configured chat root, or only user/system/plugin skills? The submit path can be correct either way because the created chat thread cwd exists before resolution.
- Should stale selected skills block submit, or should the UI offer "send as plain text" as a secondary action? The safer default is to block only selected/autocompleted stale skills and allow manual unresolved text.
- Should disabled skills appear in search with a disabled state once skills management exists, or remain hidden from invocation autocomplete like the TUI?
