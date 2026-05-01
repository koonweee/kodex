# App-Server Thread Item Coverage Plan

## Scope

Make the web timeline handle all Codex app-server `ThreadItem` variants from the checked-in `0.128.0` schema without rendering normal protocol items as visible `Debug event` or `Unsupported item` cards.

This plan is focused on presentation only. It should not change gateway event storage, app-server transport, approval semantics, image upload APIs, or generated OpenAPI contracts unless implementation discovers a real contract mismatch.

## Status

Complete.

## References

- Checked-in schema: `apps/gateway/app-server-schema/0.128.0/json/v2/ItemCompletedNotification.json`
- Upstream Codex TUI thread item handling: `codex-rs/tui/src/chatwidget.rs`
- Upstream Codex TUI collaboration rendering: `codex-rs/tui/src/multi_agents.rs`

## Current Problem

The "how can we support sending images e2e" thread shows many visible `Debug event` / `Unsupported item` rows. Those rows are not image failures. They are app-server `collabAgentToolCall` items emitted for review/fixer/wait/close subagent activity.

The reducer currently treats unknown app-server items with `itemId` as visible `debug_event` timeline items. That was useful while building the timeline, but it makes normal threads look like raw protocol dumps whenever Codex emits a first-class item type we have not mapped yet.

## App-Server Item Inventory

The pinned app-server schema currently defines these `ThreadItem.type` values:

- `userMessage`
- `hookPrompt`
- `agentMessage`
- `plan`
- `reasoning`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `collabAgentToolCall`
- `webSearch`
- `imageView`
- `imageGeneration`
- `enteredReviewMode`
- `exitedReviewMode`
- `contextCompaction`

The web timeline already supports the common message and work item types:

- `userMessage`
- `agentMessage`
- `reasoning`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `webSearch`

The missing user-facing support is:

- `collabAgentToolCall`
- `plan`
- `imageView`
- `imageGeneration`
- `enteredReviewMode`
- `exitedReviewMode`
- `contextCompaction`

The likely hidden-only support is:

- `hookPrompt`, matching Codex TUI behavior.

## Principles

- Red first: reducer and renderer behavior changes start with failing tests.
- Schema-aware fallback: known app-server item types should map to stable timeline kinds; unknown future item types should not be visible in default mode.
- Codex TUI wording as the reference, adapted to the web timeline's existing compact activity rows and status markers.
- Debug remains opt-in: raw event payloads stay available through debug mode.
- Keep chat primary: user and assistant messages should remain visually dominant; supporting work should stay compact.

## Milestone 1: Unknown Item Fallback Cleanup

Status: Complete

Failing tests first:

- An unknown app-server `ThreadItem` with an `itemId` is stored in hidden debug items, not visible `timeline.items`.
- Warnings and errors still render visibly.
- Debug mode can still expose hidden unknown events.

Implementation:

- Change the reducer fallback for unrecognized `ThreadItem` payloads.
- Keep unknown non-item lifecycle events hidden as today.
- Keep true diagnostics visible.

Exit conditions:

- Normal mode no longer shows `Unsupported item` for future app-server item variants.
- Debug mode retains enough raw event detail to inspect unexpected protocol shapes.

## Milestone 2: Collaboration Activity Items

Status: Complete

Failing tests first:

- `collabAgentToolCall` reduces to `collab_agent_tool_call`, not `debug_event`.
- Started/completed collaboration events merge into one timeline item by ID.
- Renderer displays concise activity labels without raw payloads.

Implementation:

- Add a `collab_agent_tool_call` timeline kind.
- Extract `tool`, `status`, `prompt`, `model`, `reasoningEffort`, `receiverThreadIds`, and `agentsStates`.
- Add this kind to the activity grouping set.
- Render labels based on Codex TUI behavior:
  - `spawnAgent`: completed `Spawned agent`; failed or missing receiver `Agent spawn failed`
  - `sendInput`: `Sent input to agent`
  - `wait`: running `Waiting for agent`; completed `Finished waiting`
  - `resumeAgent`: running `Resuming agent`; completed `Resumed agent`
  - `closeAgent`: completed `Closed agent`
- Put prompt excerpts, model, reasoning effort, receiver thread IDs, and final agent status/message in expanded details.

Exit conditions:

- The image attachment thread no longer shows visible `Unsupported item` rows for review/fixer subagent activity.
- Collaboration activity appears in the existing compact activity UI, not as chat bubbles.

## Milestone 3: Plan, Review, and Compaction Markers

Status: Complete

Failing tests first:

- `plan` reduces to a stable `plan` timeline kind and renders as a compact plan block.
- `enteredReviewMode` and `exitedReviewMode` render as lightweight status markers.
- `contextCompaction` renders as a lightweight status marker.
- `hookPrompt` is hidden by default.

Implementation:

- Add timeline kinds:
  - `plan`
  - `review_mode_started`
  - `review_mode_finished`
  - `context_compaction`
- Follow Codex TUI wording where practical:
  - `Code review started: {review}`
  - `Code review finished`
  - `Context compacted`
- Keep these as standalone timeline markers rather than activity-group rows.
- Hide `hookPrompt` by default while retaining the raw event in debug metadata.

Exit conditions:

- Review-mode and compaction events explain important state changes without exposing protocol names.
- Hook prompts do not pollute normal timeline rendering.

## Milestone 4: Image View and Generation Items

Status: Complete

Failing tests first:

- `imageView` reduces to `image_view` and renders a readable path label.
- `imageGeneration` reduces to `image_generation` and renders status plus generated output metadata.
- Local generated paths are not rendered as thumbnails unless a safe gateway file-serving route exists.

Implementation:

- Add timeline kinds:
  - `image_view`
  - `image_generation`
- Add these kinds to activity grouping.
- Render:
  - `imageView`: `Viewed image`, with path in details.
  - `imageGeneration`: `Generated image`, with `savedPath`, `revisedPrompt`, and status when available.
- Keep thumbnail rendering limited to already-supported user-message image previews.

Exit conditions:

- Image-related app-server work appears as readable activity instead of debug rows.
- The UI does not imply file-serving support that does not exist.

## Milestone 5: Regression Pass on Real Threads

Status: Complete

Verification:

- Replay or manually inspect the "how can we support sending images e2e" thread.
- Confirm normal mode has no repeated visible `Debug event` / `Unsupported item` rows.
- Confirm collaboration activity is compact and understandable.
- Confirm debug mode still shows raw payloads for the newly supported item types.
- Run `cd apps/web && npm test`.
- Run `cd apps/web && npm run build`.

Exit conditions:

- Web tests pass.
- Production build passes.
- The timeline degrades quietly for future app-server items instead of turning into a raw event inspector.
