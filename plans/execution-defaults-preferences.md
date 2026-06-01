# Execution Defaults Preferences Plan

## Status

Complete.

## Context

- Move permission scope and approval review controls out of the composer and into Preferences.
- Keep the composer focused on message entry, attachments, model, reasoning effort, Fast mode, context usage, and send/stop.
- Use Codex app-server config as the source of truth for future execution defaults instead of browser-local state or hardcoded composer presets.
- App-server schema `0.135.0` exposes `approval_policy`, `approvals_reviewer`, and `sandbox_mode` through `ConfigReadResponse`, and `ConfigBatchWriteParams` supports arbitrary config edits with `reloadUserConfig: true`.
- App-server thread/start and turn/start accept native `permissions` profile ids, while approval routing remains separate through `approvalPolicy` and `approvalsReviewer`.

## Current State

- `apps/gateway/src/routes/composer_settings.rs` exposes `GET /v1/composer-settings` and `PATCH /v1/composer-settings`.
- `apps/gateway/src/app_server_api.rs` currently reads `model`, `model_reasoning_effort`, `service_tier`, `default_permissions`, and a derived `permissionsPreset`, but `ComposerSettingsUpdateRequest::config_edits` only writes model, effort, and service tier.
- `apps/web/src/ComposerFooterControls.tsx` renders the composer permission profile selector and model/Fast controls together.
- `apps/web/src/composer/ComposerPanel.tsx` calls `usePermissionProfiles` for the composer and passes profile data through `InlineComposerPanel`, `MobileComposerPanel`, and `ComposerToolbar`.
- `apps/web/src/composer/settings.ts` includes `permissionProfileId` in `ComposerSettings`, turns it into `permissions` for thread creation and turn start, and patches existing threads through `ThreadSettingsUpdateRequest.permissions`.
- The completed `plans/native-permission-profiles.md` replaced hardcoded `Default permissions`, `Auto review`, and `Full access` presets with app-server `permissionProfile/list`. That revealed the mismatch: app-server profiles cover permission scope, while auto review is an approval routing default.

## Settled Decisions

- Preferences changes apply to future turns by default.
- Do not bulk-clear or rewrite existing thread-specific permission overrides in v1.
- Remove the composer permission selector rather than adding a second composer control.
- Preferences should configure both permission scope and approval review defaults.
- The UI should use app-server-native profile ids where available, and approval reviewer config for auto review.

## Milestones

### 1. Gateway Execution Defaults Contract

- Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/composer_settings.rs`, generated OpenAPI, frontend generated API types.
- Work:
  - Extend `ComposerSettingsResponse` with explicit execution default fields instead of relying only on `permissionsPreset`: `permissionProfileId`, `approvalPolicy`, `approvalsReviewer`, and a conservative derived display hint if still useful.
  - Extend `ComposerSettingsUpdateRequest` to accept execution default updates.
  - Write config edits for:
    - `default_permissions` from the selected app-server permission profile id, or `null` to return to app-server implicit defaults.
    - `approval_policy`, normally `on-request`.
    - `approvals_reviewer`, either `user` or `auto_review`.
  - Keep `config/batchWrite` using `reloadUserConfig: true` so loaded app-server threads receive config refresh where app-server supports it.
  - Preserve validation that per-request `permissions` and sandbox policy are not combined.
- Exit criteria:
  - Backend route and adapter tests cover reading and writing execution defaults.
  - `cargo fmt` and focused `cargo test` for composer settings routes/app-server adapter pass.
  - OpenAPI and `apps/web/src/api/generated/schema.ts` are regenerated if DTOs change.

### 2. Preferences Execution UI

- Scope: `apps/web/src/PreferencesModal.tsx`, `apps/web/src/PreferencesModal.test.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, `apps/web/src/styles/preferences.css`.
- Work:
  - Add an `Execution` Preferences section.
  - Query `GET /v1/composer-settings` and `GET /v1/permission-profiles` when the section is open.
  - Render permission scope as app-server profile options, with built-ins labeled clearly: `Read only`, `Workspace`, `Danger full access`, plus custom profile ids/labels.
  - Render approval review mode separately inside the Preferences panel, not the composer:
    - `Ask me` writes `approval_policy: "on-request"` and `approvals_reviewer: "user"`.
    - `Auto review` writes `approval_policy: "on-request"` and `approvals_reviewer: "auto_review"`.
  - Use Mantine controls and existing Preferences row/list styling patterns; add CSS only for layout/density.
  - Invalidate composer settings, permission profiles if needed, and model/skill queries only where the changed default can affect app-server behavior.
- Exit criteria:
  - Preferences tests cover loading, selecting permission scope, selecting review mode, save success, save error, and disabled/loading states.
  - The section works at desktop and narrow/mobile modal widths.
  - `$agent-browser` validation covers opening Preferences, changing execution defaults, and confirming the composer no longer contains permission controls.

### 3. Remove Composer Permission Controls

- Scope: `apps/web/src/ComposerFooterControls.tsx`, `apps/web/src/composer/ComposerToolbar.tsx`, `apps/web/src/composer/ComposerPanel.tsx`, `apps/web/src/composer/InlineComposerPanel.tsx`, `apps/web/src/composer/MobileComposerPanel.tsx`, `apps/web/src/composer/usePermissionProfiles.ts`, composer tests.
- Work:
  - Remove `permissionProfileId` from `ComposerSettings` and the composer UI path.
  - Remove `usePermissionProfiles` from `ComposerPanel`; the composer should not fetch permission profiles.
  - Remove permission profile props from `ComposerToolbar`, `InlineComposerPanel`, `MobileComposerPanel`, and their tests.
  - Keep model, reasoning, Fast mode, context usage, attachment, expand, send, and stop behavior intact.
  - Delete or repurpose permission-selector tests in `ComposerFooterControls.test.tsx`, `ComposerPanel.test.tsx`, `MobileComposerPanel.test.tsx`, and `App.mvp.composer-settings.test.tsx`.
- Exit criteria:
  - Composer unit/component tests prove no `Permissions:` button is rendered.
  - Existing model/Fast/context usage tests still pass.
  - Frontend build passes without dead `permissionProfiles` props in composer modules.

### 4. Future-Default Send Semantics

- Scope: `apps/web/src/composer/settings.ts`, `apps/web/src/composer/useComposerSettingsState.ts`, `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/App.tsx`, gateway route tests where needed.
- Work:
  - Update `createThreadOptions` and `composerTurnOptions` so normal composer sends no longer include `permissions` from global defaults.
  - Keep selected-thread model/reasoning/Fast overrides working through `thread/settings/update`.
  - Treat existing thread `activePermissionProfile` as metadata for display/debug only unless a future thread-level settings UI reintroduces explicit per-thread permission editing.
  - Ensure draft thread creation omits permission overrides so app-server config defaults apply.
  - Ensure active-thread normal input omits permission overrides unless there is a deliberate future per-thread override surface.
- Exit criteria:
  - Frontend tests assert new thread creation and turn input bodies omit `permissions` after Preferences owns defaults.
  - Existing-thread settings tests continue to prove model/reasoning/Fast changes are routed correctly.
  - A two-tab reasoning check is documented in tests or comments: execution defaults are app-server config, not browser-local durable state.

## Verification

- `cargo fmt`
- Focused backend tests around `composer_settings` and app-server adapter config writes.
- Regenerate OpenAPI and frontend types after DTO changes.
- Live app-server config smoke with `KODEX_SMOKE_CONFIG_ONLY=1 node apps/gateway/scripts/smoke-composer-settings.mjs`:
  `codex-cli 0.135.0` accepts and reads back `default_permissions`; `approvals_reviewer` writes with
  `auto_review` and currently reads back the compatible `guardian_subagent` spelling.
- `cd apps/web && npm test -- PreferencesModal ComposerFooterControls ComposerPanel MobileComposerPanel App.mvp.composer-settings`
- `cd apps/web && npm run build`
- `$agent-browser` smoke:
  - Desktop fine pointer: open Preferences > Execution, change permission scope and approval review, confirm save/error behavior.
  - Narrow/mobile shape: verify the Execution section is usable without overflow or hidden controls.
  - Composer: verify permission controls are absent and model/Fast/send controls still fit.

## Risks And Open Questions

- `default_permissions` is referenced by app-server thread profile provenance but is not explicitly listed in `v2/ConfigReadResponse.json`; implementation should verify live `config/read` and `config/batchWrite` behavior against the checked-in schema and local `codex-cli 0.135.0` before relying on generated field coverage alone.
- Existing threads may retain explicit app-server permission settings. This is intentional for v1; a future reset-to-default thread action should be planned separately if needed.
- Project-scoped config reads exist through `GET /v1/composer-settings?projectId=...`, but Preferences is global today. This plan should start with global execution defaults unless implementation discovers an established project-preferences pattern.
- `guardian_subagent` is accepted for compatibility, but new writes should use `auto_review`.
