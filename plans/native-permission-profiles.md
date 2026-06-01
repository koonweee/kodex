# Native Permission Profiles Plan

## Status

Proposed.

## Context

Codex app-server now exposes permission profile discovery and recommends `permissions` profile ids for thread and turn permission overrides. Kodex currently reimplements the profile layer with hardcoded frontend presets and gateway fields for approval policy, approvals reviewer, and sandbox policy. After the [Codex 0.135 app-server bump plan](codex-0-135-app-server-bump.md), this plan replaces the duplicated preset model with app-server-owned profile ids and metadata.

Contract sources are the post-bump generated app-server schema and the upstream app-server README. The implementation must verify the exact profile list shape because upstream release notes also show ongoing churn around profile DTO names.

## Current State

- `apps/web/src/composer/settings.ts` maps three local presets into raw `approvalPolicy`, `approvalsReviewer`, and sandbox options.
- `apps/web/src/ComposerFooterControls.tsx` hardcodes labels such as default permissions, auto review, and full access.
- `apps/gateway/src/app_server_api.rs` exposes legacy setting fields on thread summaries and turn start options.
- `apps/gateway/src/routes/composer_settings.rs` reads the app-server config and exposes `permissionsPreset` as a read-only hint rather than a native profile catalog.
- App-server thread/start, thread/resume, thread/fork, and turn/start now prefer `permissions` profile selection and expose `activePermissionProfile` when known.

## Goals

- Discover available permission profiles from app-server through `permissionProfile/list`.
- Send profile ids through native `permissions` params instead of reconstructing profiles from legacy policy and sandbox fields.
- Show app-server-provided profile names/descriptions where available.
- Use `activePermissionProfile` as the selected-thread truth instead of frontend heuristics.

## Non-Goals

- Do not build a profile editor.
- Do not write project or user Codex config directly from the web UI.
- Do not change approval decision APIs.
- Do not expose Kodex beyond the existing localhost or trusted VPN deployment assumption.

## Milestones

### 1. Contract and Schema Audit

- Verify post-bump `permissionProfile/list` request params, pagination, cwd behavior, returned id/display fields, and any managed requirement metadata.
- Verify how `activePermissionProfile` appears in thread summaries and setting notifications.
- Decide the gateway public DTO shape, preserving generated OpenAPI as the source for frontend types.

### 2. Gateway Profile APIs

- Add a typed app-server wrapper for `permissionProfile/list`.
- Add a gateway route such as `GET /v1/permission-profiles?cwd=...` that handles pagination and returns a compact, UI-ready catalog.
- Update thread creation, resume, fork, native settings update, and turn submission DTOs to carry a permission profile id.
- Keep legacy approval/sandbox fields only for migration or diagnostic readback until all callers are moved.

### 3. Frontend Profile Picker

- Replace hardcoded permission presets with TanStack Query data from the gateway profile route.
- Render profile labels and descriptions from app-server metadata, falling back only to ids when metadata is absent.
- Derive the selected state from `activePermissionProfile` on the selected thread or native settings snapshot.
- Make cwd-sensitive profile refresh explicit when project/thread cwd changes.

### 4. Remove Heuristics and Guardrails

- Delete local preset-to-policy reconstruction once all send paths use profile ids.
- Add guardrail tests that fail if new frontend code reintroduces durable permission derivation from raw approval/sandbox combinations.
- Add backend tests for invalid profile ids, missing profiles, profile list pagination, and sandbox/profile conflict handling.
- Add same-user two-tab coverage for profile changes through gateway-owned settings.

## Verification

- `cargo fmt`
- `cargo test`
- Regenerate OpenAPI and frontend generated types when routes or DTOs change.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Use `$agent-browser` to smoke the permission picker at desktop, narrow fine-pointer, and narrow touch shapes.

## Risks And Open Questions

- Profile ids may be project-local through cwd-sensitive config, so catalog caching needs cwd in the cache key.
- Built-in profiles may not map one-to-one to Kodex's current three labels.
- Managed requirements may make some profiles unavailable or informational; the UI should reflect app-server state rather than inventing local policy.
