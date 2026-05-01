# Optimistic User Messages Plan

## Scope

Make user-authored messages appear immediately in the Kodex timeline when the user sends them, before the gateway/app-server round trip completes. This applies to text-only messages, image-only messages, and mixed text plus image messages. The implementation should be systemic timeline behavior, not a special case layered onto the composer.

The app-server remains the source of truth. Optimistic rows are temporary client-side presentation state that must reconcile with real app-server events, or clearly fail and become retryable when a request cannot be completed.

## Status

Complete.

## Principles

- Chat should feel instant: the user's submitted content appears in the timeline immediately after Send.
- Truth still comes from app-server: optimistic rows must be replaced, reconciled, or marked failed once real events arrive.
- One timeline model: optimistic messages should flow through the same row derivation and renderer path as app-server user messages.
- Make upload latency visible without blocking the chat surface.
- Preserve attachment retry behavior: failed uploads remain recoverable without losing text or image selection.
- Keep UI calm: optimistic state should be subtle, not a noisy progress system.
- Avoid domain-specific hacks. This must work for all user messages, not only images.

## Current Problem

The composer currently waits for the send path before timeline content appears:

- Text-only messages wait for `POST /v1/threads/:threadId/turns` and then for app-server timeline events.
- Image messages wait for `POST /v1/uploads/images`, then `POST /v1/threads/:threadId/turns`, then app-server timeline events.
- Large images or slow uploads create a visible gap where the composer has accepted the action but the conversation does not yet show the user message.
- Failed image uploads stay in the composer as retryable attachments, which is correct, but successful sends do not provide immediate timeline feedback.

## UX Model

When a user sends:

- The composer clears immediately for normal sends.
- The timeline immediately shows a right-aligned user message row using the same visual treatment as confirmed user messages.
- Pending images render as the selected thumbnail previews above the text bubble.
- A subtle status appears near the optimistic row:
  - `Uploading` while image files are being uploaded.
  - `Sending` after uploads succeed and the turn request is in flight.
  - `Failed` if upload or turn start fails.
- Confirmed messages should not show status text or spinners.

When send succeeds:

- The optimistic row remains visible until the app-server user-message event arrives.
- When the matching app-server event arrives, replace or merge the optimistic row with the confirmed row without visual duplication.
- If the app-server does not emit a matching user-message event before assistant/tool events arrive, keep the optimistic row as the visible user message for that turn and mark it confirmed once the turn starts.

When send fails:

- Text-only failed sends become a failed optimistic row with a retry action or restore the composer draft.
- Image-upload failures should keep the existing retryable attachment behavior and also avoid leaving a misleading sent timeline row.
- Turn-start failures after upload should show the row as failed and allow retry using the already-uploaded image paths where possible.

## Data Model

Add first-class optimistic timeline state rather than ad hoc component-only rows.

Candidate structures:

```ts
type OptimisticTimelineItem = TimelineItem & {
  optimistic: true;
  clientRequestId: string;
  confirmationState: "uploading" | "sending" | "sent" | "failed";
  error?: string;
};
```

Better if integrated into `TimelineItem`:

```ts
type TimelineItem = {
  ...
  source?: "app_server" | "optimistic";
  clientRequestId?: string;
  confirmationState?: "uploading" | "sending" | "sent" | "failed";
  error?: string;
};
```

The second option keeps row derivation and rendering simpler because optimistic and confirmed user messages share one item shape.

## Reconciliation Strategy

Each send creates a `clientRequestId`, for example `client-message-1`.

For existing threads:

- Insert an optimistic user-message item into the selected timeline before starting uploads.
- Use a synthetic id such as `optimistic-${clientRequestId}`.
- Use a synthetic sequence greater than the current `timeline.lastSeq`, or add explicit optimistic ordering in row derivation.
- If `turn/start` returns or the first turn event identifies a turn id, associate the optimistic item with that turn id.

For draft/new threads:

- Create the thread first if no thread id exists.
- Once the thread exists and is selected, insert the optimistic message before uploads/start-turn.
- This still avoids the app-server turn event delay, while respecting that timeline state is thread-scoped.

Matching confirmed events:

- Prefer matching by app-server user-message event content and nearest pending optimistic item in the same thread/turn.
- For image messages, match by text plus uploaded `localImage` paths.
- For text-only messages, match by exact text and pending optimistic order.
- On match, replace optimistic item id/payload/status with confirmed app-server data and preserve stable UI where possible.
- If matching is ambiguous, keep both only in debug mode; default UI should avoid duplicate user bubbles.

## UI Details

Default confirmed user message:

- Same as today: right-aligned bubble, no status.

Optimistic text-only user message:

- Same bubble placement and size.
- Slight opacity reduction or tiny status line under the bubble while sending.
- Avoid large spinners inside the bubble.

Optimistic image user message:

- Thumbnail grid appears immediately above the text bubble.
- Images use object URLs before upload and local preview mapping after upload.
- During upload, each thumbnail can show a subtle overlay or the row can show one status line. Prefer one row-level status to avoid noisy repeated overlays.

Failed user message:

- Keep the content visible.
- Show a compact error status and retry action.
- For image upload failures, keep pending attachments in the composer if the send never reached app-server; do not also show a committed failed timeline row unless the composer was cleared.

Active-turn steering:

- Queued steer rows should keep their current explicit queue behavior.
- When a queued steer row is submitted, it can become an optimistic user message inside the active turn with `sending` status.
- Failed steer sends should remain retryable.

## Milestone 1: Timeline Optimistic Item Support

Status: Complete

Failing tests first:

- Adding an optimistic user item causes `deriveTimelineRows` to render it in chronological order.
- Optimistic user items use the normal `user_message` renderer.
- Optimistic status is available to the renderer without exposing raw protocol labels.
- Replaying app-server events does not discard unrelated optimistic items.

Implementation:

- Extend `TimelineItem` with optional `source`, `clientRequestId`, `confirmationState`, and `error`.
- Add reducer actions or helper functions for adding, updating, confirming, and failing optimistic items.
- Keep optimistic item handling in `timeline/reducer.ts` or a nearby timeline module, not inside JSX rendering code.

Exit conditions:

- Unit tests prove optimistic items derive/render through the same path as normal user messages.
- Existing timeline event replay behavior remains unchanged for app-server events.

## Milestone 2: Text-Only Optimistic Sends

Status: Complete

Failing tests first:

- Sending text in an existing idle thread immediately renders the user bubble before `startTurn` resolves.
- The composer clears immediately after send.
- Failed `startTurn` marks the optimistic row failed and leaves a retry path.
- When the app-server user-message event arrives, the optimistic row does not duplicate.

Implementation:

- In `handleSubmitTurn`, create a client request id and optimistic text user item before awaiting `startTurn`.
- Update status from `sending` to `sent` when `startTurn` succeeds.
- Reconcile confirmed user-message events against pending optimistic items.
- Add a retry action or restore-draft behavior for failed text sends.

Exit conditions:

- Text-only sends feel instant.
- No duplicate user bubble appears when app-server events catch up.

## Milestone 3: Image Optimistic Sends

Status: Complete

Failing tests first:

- Sending text plus images immediately renders thumbnails and text in the timeline while upload is pending.
- Image-only sends immediately render thumbnail grid without an empty bubble.
- Upload success transitions optimistic status from `uploading` to `sending`.
- Upload failure keeps attachments retryable and does not leave a misleading confirmed message.
- Turn-start failure after upload marks the optimistic row failed and can retry without re-uploading already uploaded images.

Implementation:

- Build optimistic image entries from pending attachment object URLs.
- Preserve object URLs while optimistic rows reference them.
- After upload, add preview mappings for local paths and update optimistic item images to localImage paths when useful.
- On upload failure, either keep the optimistic row as failed or remove it and restore composer state; choose one behavior and keep it consistent.

Exit conditions:

- Image messages appear immediately.
- Upload delays are visible but do not block timeline feedback.
- Failed image sends are recoverable.

## Milestone 4: Active-Turn Steer Sends

Status: Complete

Failing tests first:

- Queued steer submission creates an optimistic user message in the active turn.
- Successful steer confirmation removes or confirms the queued state without duplication.
- Failed steer keeps a retryable queued row or failed optimistic row, but not both in a confusing way.

Implementation:

- Decide whether queued rows remain separate until the user clicks `Steer`, then become optimistic timeline rows.
- Associate optimistic steer messages with the active turn id immediately.
- Reconcile against subsequent app-server user-message events.

Exit conditions:

- Active-turn steering feels consistent with normal sends.
- The queue remains useful for intentional delayed steering.

## Milestone 5: Polish And Verification

Status: Complete

Implementation:

- Add subtle optimistic/failed styling to user message rows.
- Ensure bottom-pinned timeline behavior still scrolls to newly inserted optimistic rows.
- Verify desktop and mobile composer/timeline layouts.
- Run independent review before marking complete.

Exit conditions:

- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Relevant backend tests still pass if DTOs or upload behavior change.
- Independent review reports no major issues remain.

## Open Questions

- For failed text-only sends, should retry happen from the failed timeline row or should the draft be restored into the composer?
- For image upload failures, should the optimistic row remain failed in the timeline or should the composer retain ownership until upload succeeds?
- Can app-server provide any stable client metadata echo in user-message events? If not, reconciliation must rely on content/order heuristics.
- Should optimistic rows appear in debug mode as synthetic events, or remain purely presentation state?
