# Inline Skill Badges Plan

## Status

Complete.

## Goal

Render selected skills inline as compact badges in user-authored timeline messages without scanning message text for `$skill` strings. The committed timeline must converge across tabs, reloads, reconnects, and snapshot refreshes by using gateway-normalized metadata instead of browser-local composer bindings.

## Decisions

- First milestone is user-authored skill mentions only. Assistant-authored `$skill` text remains plain Markdown/text unless app-server later emits structured spans for assistant content.
- Frontend may use composer-local bindings for optimistic rows, but committed timeline badges come from gateway-normalized message metadata.
- Manual typed `$skill` text that was not selected through autocomplete remains plain text in the badge renderer, even if the gateway can still invoke it through submit-time skill resolution.
- Historical badges preserve canonical `name` and `path` from send time. Display name and scope can be enriched from the current catalog when available, but missing catalog metadata must not make historical badges disappear.
- The renderer must not search for `$` tokens. It only renders ranges supplied as structured `skillMentions`.

## Non-Goals

- Do not replace the composer `Textarea` with a rich editor in this plan.
- Do not style assistant-generated `$skill` text by heuristic detection.
- Do not build a skills management UI.
- Do not change app-server protocol semantics or rely on app-server fields outside the checked-in generated schema.
- Do not reintroduce persisted gateway timeline replay as a canonical history source.

## Current Kodex Grounding

- `apps/gateway/src/app_server_api.rs` defines `UserInput::Text { text, text_elements }`, `UserInput::Skill { name, path }`, and `TextElement { byte_range, placeholder }`.
- Checked-in app-server schema documents `text_elements` as "UI-defined spans within `text` used to render or persist special elements" and `TextElement.byteRange` as a byte range in the parent text buffer.
- Persisted app-server `userMessage` thread items can contain `content: UserInput[]`, so confirmed thread snapshots can carry both text input and sidecar skill inputs.
- `apps/web/src/composer/ComposerPanel.tsx` keeps selected skill bindings in React state while editing and submits sidecar `skill` inputs through `useComposerOrchestration`.
- `apps/gateway/src/skills.rs` currently canonicalizes selected or uniquely resolved skills before forwarding input to app-server.
- `apps/web/src/timeline/presentation.ts` currently reduces user messages to `TimelineItem.text` and `TimelineItem.images`; it does not preserve text element ranges or sidecar skill metadata.
- `apps/web/src/timeline/state.ts` has optional structured presentation fields such as `collab`, which is the right pattern for adding optional `skillMentions`.
- `GET /v1/threads/{threadId}` reads app-server `thread/read includeTurns:true` and is the canonical selected-thread timeline source. Selected-thread SSE is a live overlay; reconnect uncertainty should trigger snapshot refresh, not event replay.

## Upstream Codex Cross-Reference

- App-server README states skill invocation should include text containing `$skill-name` plus a structured `skill` input item. Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- The checked-in app-server schema exposes `UserInput.Text.text_elements`, `UserInput.Skill`, and `UserInput.Mention`.
- Codex TUI keeps resolved mention bindings separate from visible composer text and encodes history mentions as durable linked mention text for recall. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/mention_codec.rs
- TUI also has fallback parsing for raw `$name`, but Kodex should not use that fallback for timeline badge styling.

## Data Model Direction

Add a Kodex-owned normalized display model:

```ts
type TimelineSkillMention = {
  start: number;
  end: number;
  name: string;
  path: string;
  displayName?: string;
  scope?: string;
};
```

Store it on frontend `TimelineItem`:

```ts
type TimelineItem = {
  // existing fields
  skillMentions?: TimelineSkillMention[];
};
```

Also expose equivalent gateway DTO fields on thread snapshots and live normalized timeline item events if the gateway starts producing typed item projections. The field belongs to the Kodex projection, not raw app-server `TextElement`, because app-server `TextElement` does not include `type`, `name`, or `path`.

Offsets are frontend string offsets in the displayed `TimelineItem.text`, not app-server byte offsets. The gateway may consume app-server byte ranges, but it must expose offsets that match JavaScript string indexing so the frontend renderer can split text without converting UTF-8 byte offsets.

## Ownership Model

- App-server owns persisted thread history and the base `UserInput[]` shape.
- Gateway owns canonical skill validity and converts app-server/user-input shapes into Kodex timeline `skillMentions`.
- Frontend owns active-draft bindings, optimistic rendering, and pure rendering of provided ranges.
- Frontend must not decide whether a committed historical `$name` is a valid skill by consulting a local catalog.
- Gateway catalog changes can enrich future renders but must not mutate historical identity from `path` and canonical `name`.

## Milestone 1: Composer Text Elements

Acceptance criteria:

- Selected autocomplete skills still insert visible `$skill-name` text.
- The submitted text `UserInput` includes `text_elements` for each selected skill token range.
- The submitted request still includes sidecar `{ type: "skill", name, path }` inputs.
- Text element byte ranges are computed against the UTF-8 encoded text, matching app-server schema language.
- Binding invalidation stays defensive: if the visible token no longer exactly matches the selected skill token, drop that text element and sidecar candidate.

Implementation notes:

- Extend `apps/web/src/composer/skillMentions.ts` with a helper that converts valid bindings into `TextElement[]`.
- Update `apps/web/src/composer/useComposerOrchestration.ts` so the text input is built with `text_elements`.
- Keep sidecar skill inputs deduped by path as they are today.

Tests:

- Unit test UTF-8 byte range conversion with ASCII and non-ASCII text before a skill token.
- Component test confirms selected skill submit sends text with `text_elements` and a sidecar skill input.
- Existing Backspace and binding invalidation tests still pass.

## Milestone 2: Gateway Canonical Mention Projection

Acceptance criteria:

- Gateway derives normalized `skillMentions` for selected skills from text input `text_elements` plus validated sidecar `skill` inputs.
- Gateway does not derive display mentions from raw `$` token scanning.
- Stale selected sidecar skills still fail clearly, matching the current resolver behavior.
- Manual typed and uniquely resolved `$skill` invocation remains supported by the submit resolver, but it does not create a timeline badge unless there was structured range metadata.
- Gateway preserves canonical `name` and `path` from the resolved skill. It may attach current `displayName` and `scope` when available.
- Gateway resolves skills for existing or newly-created threads by reading thread cwd without `includeTurns`, because new threads reject turn snapshots until the first turn materializes.
- Gateway persists selected skill mention projections when a turn starts and commits them to the materialized user item, so badges survive thread navigation, snapshot reloads, and gateway restarts even if app-server snapshots omit `text_elements`.

Implementation notes:

- Add a small gateway projection helper near `apps/gateway/src/skills.rs` or a new timeline projection module if the code naturally wants separation.
- Pair ranges with sidecar skills conservatively. If counts or visible text do not match, omit the badge metadata rather than guessing.
- Convert app-server byte ranges to displayed string character offsets before exposing to the web timeline.
- Prefer attaching `skillMentions` to `ThreadItemSnapshot` or `TimelineItemUpsertPayload` so both snapshots and live overlays share the same field.

Tests:

- Backend test for selected skill input with text element range produces one normalized mention.
- Backend test for range/text mismatch produces no mention but still preserves normal message text behavior.
- Backend test for non-ASCII text before a skill token converts byte range to frontend-safe character offsets.
- Backend test confirms manual text-only `$skill` does not produce `skillMentions`.

## Milestone 3: Snapshot and Live Timeline Normalization

Acceptance criteria:

- `GET /v1/threads/{threadId}` snapshots include enough normalized metadata for the frontend to render skill badges after reload.
- Selected-thread live item upserts include the same normalized metadata for low-latency updates.
- Snapshot refresh replaces optimistic badge metadata with gateway-normalized badge metadata.
- Existing timeline ordering, snapshot-first loading, and debug raw payload behavior remain unchanged.

Implementation notes:

- `ThreadItemSnapshot` currently exposes `raw_payload`; add optional Kodex projection fields without removing raw payload.
- Keep raw app-server payloads available for debug disclosure, but renderers should consume `TimelineItem.skillMentions`.
- Do not depend on `/v1/events` replay for historical badges.

Tests:

- Gateway route test for `thread/read includeTurns:true` maps a user message with content `UserInput[]` to a snapshot item carrying normalized mentions.
- Frontend snapshot reducer test confirms a loaded thread renders a user message item with `skillMentions`.
- Live item upsert test confirms an incoming item with mention metadata merges into the same timeline item without duplicate rows.

## Milestone 4: Frontend Timeline Rendering

Acceptance criteria:

- `TimelineItem` includes optional `skillMentions`.
- User message rendering splits text by provided ranges and renders skill ranges as badges.
- Plain text around badges keeps existing wrapping and line-break behavior.
- Copy actions still copy the original plain `TimelineItem.text`, including `$skill-name`.
- Missing, overlapping, out-of-bounds, or text-mismatched ranges are ignored defensively.
- Assistant Markdown rendering is unchanged.

Implementation notes:

- Add a small pure renderer/helper in `apps/web/src/timeline`, for example `renderInlineSkillMentions.tsx`.
- Keep badge styling compact and token-backed in `apps/web/src/styles/timeline.css`.
- A badge should expose accessible text such as `$agent-browser skill`.
- Use the canonical `displayName` only for tooltip/title if showing it inline would obscure the actual `$name` text. Primary visible label should remain `$name` for copy/recognition parity.

Tests:

- Renderer test for user message with one skill mention badge and surrounding text.
- Renderer test for multiple badges and multiline text.
- Renderer test for invalid ranges falling back to plain text.
- Copy toolbar test remains unchanged and copies original plain text.

## Milestone 5: Optimistic User Message Parity

Acceptance criteria:

- Immediately submitted user messages can show provisional badges using composer-local bindings.
- Failed optimistic rows with provisional skill mentions keep their badge display while preserving existing retry/error UX for other sends.
- Confirmed rows replace provisional metadata with gateway-normalized metadata when the app-server item arrives.
- If confirmation arrives without `skillMentions`, the originating client may preserve validated provisional ranges for the same visible text so the just-sent row does not flicker or fall back. Other clients still require gateway/app-server `skillMentions` to render badges.

Implementation notes:

- Extend `OptimisticUserMessageInput` with optional `skillMentions`.
- Populate it from valid composer bindings at submit time.
- Merge logic should prefer incoming app-server/gateway `skillMentions` over optimistic local mentions, but preserve existing provisional mentions when incoming text still validates them and the incoming item omits mention metadata.

Tests:

- Optimistic reducer test stores skill mentions on a pending user row.
- Confirmation merge test replaces optimistic mentions with incoming normalized mentions.
- Confirmation-without-mentions test preserves provisional mention metadata only when the confirmed visible text still validates it.

## Milestone 6: Multi-Client Verification

Acceptance criteria:

- Tab A submits a selected skill and sees an optimistic badge.
- Tab B opens or refreshes the same thread and sees the badge from snapshot metadata, not from Tab A's React state.
- If Tab A reconnects or receives `timeline.snapshot_required`, the badge converges from snapshot.
- If the skill is disabled/uninstalled after the message, historical badge still shows `$name` from committed metadata.

Tests:

- Backend snapshot test covers historical skill metadata after catalog miss.
- Frontend two-client-shaped test simulates one client submitting and another loading a snapshot with `skillMentions`.
- Existing focused suites still pass:
  - `cargo test -p kodex-gateway`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`

## UX Direction

- Badge is inline, compact, and visually distinct from code spans.
- Badge label should be `$skill-name`.
- Optional tooltip can show display name, scope, and path if available.
- Badges should wrap naturally with text and not create horizontal overflow on mobile.
- Historical unavailable skills use a neutral badge tone rather than an error tone.

## Risks

- App-server may not preserve `text_elements` in all thread item snapshots. Mitigation: gateway can still project mentions for live accepted input, but reload parity requires snapshot preservation or a gateway-owned committed projection.
- `TextElement` lacks type/name/path. Mitigation: never render from `TextElement` alone; pair it with validated sidecar `skill` input.
- Byte-to-character conversion can be wrong around multi-byte characters. Mitigation: centralize conversion and test non-ASCII strings.
- Existing message text extraction currently collapses `content: UserInput[]` into text only. Mitigation: update presentation normalization in one focused path instead of adding renderer-level raw-payload parsing.

## Exit Conditions

- Selected skills render as inline badges in optimistic and confirmed user messages.
- Reload and second-tab snapshot render the same badges.
- No badge rendering depends on `$` string scanning.
- Manual unstructured `$skill` remains plain text in timeline rendering.
- Tests cover backend projection, frontend normalization, rendering, optimistic reconciliation, and invalid range fallback.
