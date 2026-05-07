# Skill Badge Catalog Enrichment Plan

## Status

Proposed.

## Goal

Enrich timeline skill mention badges with catalog-backed display metadata when Kodex can prove the badge identity matches a current skill catalog entry. Badges must still render historical or stale skills as the original `$skill-name` token when catalog metadata is unavailable.

## Decisions

- `name` and `path` remain the durable skill mention identity. Catalog metadata is decorative enrichment.
- Match catalog entries by `path` first. If a mention also has `name`, require the catalog `name` to match before applying display metadata.
- Missing catalog entries, disabled skills, deleted skills, and catalog load failures must not remove badges or change the user-authored token.
- The visible inline label should preserve message fidelity by default: render the original token slice, currently `$name`. A later UI choice may show `displayName`, but copy and fallback behavior must remain token-backed.
- Use `brandColor` only as a small accent, not as the full badge background. Invalid CSS colors are ignored.
- Use `iconSmall` only. Do not use `iconLarge` for inline timeline badges.
- Do not expose raw local icon paths directly to the browser. Icons need a gateway-served URL derived from matched catalog metadata.

## Non-Goals

- Do not build a skill management UI.
- Do not change app-server `UserInput::Skill`; it currently carries only `name` and `path`.
- Do not scan arbitrary `$` text in timeline rendering. Rendering stays driven by structured `skillMentions`.
- Do not treat a missing current catalog match as an error state for historical messages.
- Do not add public-safe filesystem authorization. This repo still assumes localhost or trusted VPN deployment.

## Current Kodex Grounding

- `apps/gateway/src/app_server_api.rs` defines `SkillMetadata` with `name`, `path`, `description`, `enabled`, `scope`, `shortDescription`, and optional `interface`.
- `SkillInterface` already exposes `displayName`, `shortDescription`, `brandColor`, `defaultPrompt`, `iconSmall`, and `iconLarge`.
- `GET /v1/skills` in `apps/gateway/src/routes/skills.rs` returns `SkillsCatalogResponse` from the gateway skill cache.
- `TimelineSkillMention` in `apps/gateway/src/app_server_api.rs` currently includes `start`, `end`, `name`, `path`, plus optional `displayName` and `scope`.
- `skill_mention_from_text_element` currently sets `display_name: None` and `scope: None` after deriving the mention from text elements and sidecar skill inputs.
- `apps/web/src/composer/skillMentions.ts` already has `skillDisplayName` and `skillDescription` helpers that prefer `interface.displayName` and `interface.shortDescription`.
- `apps/web/src/timeline/renderers.tsx` renders `kodex-inline-skill-badge` from structured mention ranges and already includes `displayName`, `scope`, and `path` in the title when present.
- `apps/gateway/src/routes/file_preview.rs` serves local image and Markdown previews at `/v1/threads/{threadId}/files/preview`, with explicit localhost/trusted-VPN assumptions.

## Data Model

Extend the gateway-owned projection:

```ts
type TimelineSkillMention = {
  start: number;
  end: number;
  name: string;
  path: string;
  displayName?: string;
  scope?: string;
  shortDescription?: string;
  brandColor?: string;
  iconSmallUrl?: string;
};
```

Do not expose `iconSmall` as a raw local path in frontend DTOs. If the gateway cannot produce a safe preview URL, omit `iconSmallUrl`.

## Enrichment Rules

Given a `TimelineSkillMention` and a catalog entry:

1. Require `mention.path === skill.path`.
2. Require `mention.name === skill.name` unless the mention name is absent in some future payload shape.
3. Set `displayName` to trimmed `skill.interface.displayName` when present, else leave unset or use `skill.name` only where the frontend helper needs a resolved label.
4. Set `scope` from `skill.scope`.
5. Set `shortDescription` to trimmed `skill.interface.shortDescription`, falling back to trimmed `skill.shortDescription`, then trimmed `skill.description`.
6. Set `brandColor` only if the string is non-empty. The frontend must still validate before applying it to CSS.
7. Set `iconSmallUrl` only when `skill.interface.iconSmall` is present and the gateway can serve that image through an approved preview route.

Fallback: if there is no match, render the badge from the message text slice and keep title metadata to `path` or `$name` only.

## Milestone 1: Gateway DTO and Projection Enrichment

Acceptance criteria:

- `TimelineSkillMention` exposes optional `shortDescription`, `brandColor`, and `iconSmallUrl`.
- Gateway projection populates `displayName`, `scope`, `shortDescription`, and `brandColor` when the resolved skill is available during submit-time projection.
- Existing app-server snapshot projection still works when only `UserInput::Skill { name, path }` is available.
- Missing enrichment fields do not affect badge rendering.
- OpenAPI and `apps/web/src/api/generated/schema.ts` are regenerated after DTO changes.

Implementation notes:

- Add optional fields to `TimelineSkillMention` in `apps/gateway/src/app_server_api.rs`.
- Extract a helper such as `enrich_timeline_skill_mention(mention, skill)` near the existing skill mention projection code.
- The submit path already resolves selected skills in `apps/gateway/src/skills.rs`; reuse that catalog result where practical instead of adding another catalog request.
- Preserve persisted `timeline_skill_mentions` compatibility by making all new fields optional.

Tests:

- Backend unit test: selected skill with catalog interface metadata produces a mention with display name, scope, short description, and brand color.
- Backend unit test: path/name mismatch leaves enrichment fields unset.
- Backend snapshot/store test: older persisted mention JSON without new optional fields still deserializes.

## Milestone 2: Icon Preview Route

Acceptance criteria:

- Matched `iconSmall` paths can be rendered in the browser without exposing raw local paths.
- Only image files accepted by the existing preview sniffer are served.
- Missing, non-image, oversized, or unreadable icon paths omit `iconSmallUrl` or return a normal preview error without breaking timeline rendering.
- The route documentation repeats the localhost/trusted-VPN assumption.

Implementation options:

- Preferred: add a skill-icon-specific route such as `/v1/skills/icon?path=...` that canonicalizes and sniffs the file using the same image validation logic as `file_preview.rs`.
- Alternative: reuse `/v1/threads/{threadId}/files/preview` only when a thread id is available in the renderer, but avoid coupling global skill metadata to selected-thread file previews if the badge can appear outside a selected thread context.

Implementation notes:

- Factor image sniffing from `apps/gateway/src/routes/file_preview.rs` into a shared helper if both routes need it.
- Only produce `iconSmallUrl` for a path sourced from a matched catalog entry, not from frontend input.
- Keep cache headers private.

Tests:

- Gateway route test serves a PNG/JPEG/WebP/GIF skill icon with the expected content type.
- Gateway route test rejects Markdown and unsupported files.
- Gateway projection test omits `iconSmallUrl` when `iconSmall` is missing.

## Milestone 3: Optimistic Composer Metadata

Acceptance criteria:

- Immediately submitted user messages can show enriched provisional badges from the selected `SkillMetadata`.
- Confirmed gateway metadata replaces optimistic metadata when available.
- Failed optimistic rows keep their provisional badge metadata without depending on a later catalog fetch.

Implementation notes:

- Extend `SkillMentionBinding` in `apps/web/src/composer/skillMentions.ts` with optional `displayName`, `scope`, `shortDescription`, `brandColor`, and `iconSmallUrl`.
- Populate those fields in `replaceSkillMentionToken` from the selected `SkillMetadata`.
- Extend `timelineSkillMentionsFromBindings` to carry optional metadata.
- Keep `skillInputsFromBindings` unchanged: app-server sidecar inputs should remain `{ type: "skill", name, path }`.

Tests:

- Frontend unit test: binding conversion includes display metadata when a selected skill has catalog fields.
- Frontend reducer test: confirmed metadata still wins over optimistic metadata.

## Milestone 4: Badge Rendering

Acceptance criteria:

- Badge visible text remains the original token slice from `TimelineItem.text`.
- Tooltip includes display name, short description, scope, and path when present.
- Valid brand colors render as an inline accent.
- Invalid brand colors are ignored.
- `iconSmallUrl` renders as a small leading image without layout shift or overflow.
- Plain fallback badges still render for historical catalog misses.

Implementation notes:

- Update `InlineSkillMentionText` in `apps/web/src/timeline/renderers.tsx`.
- Add a pure helper for tooltip construction and brand color validation to keep the renderer readable.
- Use CSS custom properties such as `--skill-accent-color` rather than generating many classes.
- Keep `.kodex-inline-skill-badge` compact in `apps/web/src/styles/timeline.css`; add stable icon dimensions like `width: 1em; height: 1em`.
- Use `alt=""` for decorative icons and keep the badge `aria-label` based on the visible `$name` token.

Tests:

- Renderer test: enriched mention displays token text and title includes short description.
- Renderer test: valid brand color applies an accent style.
- Renderer test: invalid brand color is omitted.
- Renderer test: icon URL renders a decorative image.
- Renderer test: no enrichment still renders the `$name` badge.

## Milestone 5: Multi-Client and Stale Catalog Verification

Acceptance criteria:

- Tab A submits a selected enriched skill and sees an optimistic icon/accent/tooltip.
- Tab B opens the same thread and sees gateway-projected metadata from the snapshot.
- If a skill is deleted or disabled after the message, both tabs still render the plain `$name` badge from persisted mention identity.
- `skills.changed` invalidation can update future enrichment, but it must not rewrite historical `name`/`path` identity.

Tests:

- Backend test: persisted historical mentions continue to load after catalog miss.
- Frontend two-client-shaped test: one client receives enriched snapshot metadata without using the submitting client's React state.
- Existing verification remains:
  - `cargo test -p kodex-gateway`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`

## UX Direction

- Badge remains inline and compact.
- Accent color should read as a left border, dot, or subtle icon ring, not as a saturated badge fill.
- Tooltip format should be concise:

```text
Display Name · Short description · scope · path
```

- If `displayName` and `$name` are identical, avoid repeating both in the tooltip.
- If an icon fails to load, hide it and keep text alignment stable.
