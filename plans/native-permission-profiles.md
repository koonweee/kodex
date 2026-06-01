# Native Permission Profiles Plan

## Status

Complete.

Implemented gateway discovery and forwarding for app-server permission profiles,
replaced frontend hardcoded permission presets with profile catalog data, and
regenerated the OpenAPI/frontend type artifacts. Automated verification covers
gateway pagination/forwarding/conflict handling plus frontend picker rendering,
settings hydration, and create/turn/patch send paths. Browser smoke was not run
in this session because the in-app Browser control surface was unavailable.

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

- Completed: verified `permissionProfile/list` pagination and cwd resolution
  against the checked-in app-server schema and implemented compact generated
  OpenAPI DTOs for the frontend.
- Completed: gateway thread summaries, command responses, and settings
  notifications now expose or preserve `activePermissionProfile` where present.
- Completed: public gateway DTOs are generated into the frontend OpenAPI types.

### 2. Gateway Profile APIs

- Completed: `CodexClient::permission_profile_list` wraps
  `permissionProfile/list`.
- Completed: `GET /v1/permission-profiles` resolves cwd/project context,
  follows pagination, and returns compact profile summaries.
- Completed: thread creation, chat creation, thread settings updates, queue
  rows, self-control thread creation, and turn starts can carry native
  `permissions` profile ids.
- Completed: legacy approval/sandbox fields remain available for compatibility
  and diagnostics, but frontend send paths no longer reconstruct profiles from
  them.

### 3. Frontend Profile Picker

- Completed: the composer loads permission profiles through TanStack Query with
  cwd in the cache key.
- Completed: the picker renders app-server labels/descriptions and falls back to
  ids only when metadata is absent.
- Completed: selected-thread state comes from `activePermissionProfile`, with a
  raw-payload fallback for transitional payloads.
- Completed: profile queries refresh when the composer cwd changes.

### 4. Remove Heuristics and Guardrails

- Completed: local preset-to-policy reconstruction was removed from frontend
  composer settings.
- Completed: frontend guardrail tests assert `activePermissionProfile` wins over
  conflicting legacy approval/sandbox payloads and builders emit native
  `permissions`.
- Completed: backend tests cover profile pagination, create/turn forwarding,
  active profile projection, and permissions/sandbox conflict rejection.
- Covered by existing gateway-owned settings convergence: profile changes flow
  through native thread settings updates and canonical thread summaries rather
  than browser-local durable state.

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
