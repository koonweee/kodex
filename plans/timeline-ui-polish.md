# Timeline UI Polish Plan

## Scope

Refine the Kodex web timeline so it behaves like a Codex app-server client rather than a raw event inspector. The UI should follow the Codex desktop app direction: chat-first, dark, calm, compact, and focused on user-visible work. App-server protocol details remain available for debugging, but the default experience must not expose raw JSON, item IDs, event method names, empty lifecycle rows, or transport noise.

This plan generalizes across Codex app-server item types. It must not special-case weather, web search prompts, or other domain-specific user requests.

## Status

Proposed.

## Principles

- Red first: every implementation chunk starts with a failing reducer, renderer, component, or Playwright test.
- Protocol-aware, not prompt-specific: render Codex app-server concepts such as messages, reasoning, web search, command execution, file changes, and tool calls.
- Chat is primary: user and assistant messages should be visually dominant; tool activity should support the conversation without overwhelming it.
- Debug is opt-in: raw event payloads, item IDs, method names, and hidden lifecycle events belong behind an explicit debug mode.
- Keep generated OpenAPI as the public contract. Do not introduce handwritten API contract docs or frontend DTO duplicates.

## Design Target

The reference design is the Codex desktop app pattern:

- A quiet dark shell.
- Thread list on the side.
- Current conversation/work trace in the center.
- Composer anchored at the bottom.
- Minimal badges and labels.
- Work/tool activity shown as compact, collapsible supporting rows.
- Raw protocol details hidden unless the user asks for debug information.

## Current Problem

The web client currently renders many app-server events as separate cards. In a web-search thread this produces a chaotic timeline:

- Empty `userMessage` items show `No user content`.
- Empty `reasoning` items show raw payload JSON.
- `item/started` and `item/completed` rows expose protocol labels.
- `webSearch` actions render as raw JSON.
- Normal `completed` statuses appear on almost every row.
- Assistant messages are buried between internal lifecycle and tool events.

The result is useful for debugging the reducer, but not for normal Codex usage.

## Milestone 1: Presentation Timeline Model

Status: Complete

Failing tests first:

- App-server events reduce into user-facing timeline blocks instead of raw event cards.
- Unknown events do not crash the reducer.
- Raw payloads are retained for debug mode but are not rendered by default.

Implementation:

- Add a presentation layer between `EventEnvelope` and React renderers.
- Keep the gateway event envelope as the API contract input.
- Reduce events into turn-aware blocks such as:
  - `user_message`
  - `assistant_message`
  - `reasoning_summary`
  - `web_search_group`
  - `command_execution`
  - `file_change`
  - `mcp_tool_call`
  - `dynamic_tool_call`
  - `approval_request`
  - `warning`
  - `error`
  - `debug_event`
- Preserve event ordering within a turn.
- Store raw payload only as debug metadata.

Exit conditions:

- Reducer tests cover message, reasoning, web-search, command, file-change, and unknown item inputs.
- Existing MVP timeline tests still pass or are updated to the new presentation model.
- The default renderer receives user-facing blocks, not raw app-server payloads.

## Milestone 2: Empty and Lifecycle Event Filtering

Status: Complete

Failing tests first:

- Empty `userMessage` items are omitted.
- Empty `reasoning` items are omitted.
- `turn/started`, `turn/completed`, token usage, thread status changes, and non-error lifecycle updates do not render as timeline cards by default.
- Warning and error lifecycle events remain visible.

Implementation:

- Treat normal lifecycle events as state updates, not display blocks.
- Keep hidden events in debug metadata.
- Filter no-content message/reasoning items before rendering.

Exit conditions:

- A weather/web-search thread no longer shows `No user content` rows.
- Empty reasoning payloads never render raw JSON in default mode.
- Warnings and errors remain visible.

## Milestone 3: Human Labels and Status Rules

Status: Complete

Failing tests first:

- Protocol labels such as `agent_message`, `user_message`, `item/started`, and `reasoning` are not visible in default mode.
- Normal completed items do not show `COMPLETED` badges.
- Running, failed, waiting, cancelled, and approval-required states remain visible.

Implementation:

- Map protocol concepts to user-facing labels:
  - `agentMessage` -> `Assistant`
  - `userMessage` -> `You`
  - `reasoning` -> `Reasoning`
  - `webSearch` -> `Web search`
  - `commandExecution` -> `Command`
  - `fileChange` -> `File change`
  - `mcpToolCall` -> `MCP tool`
  - `dynamicToolCall` -> `Tool`
- Hide status for normal completed blocks.
- Show status only when it changes what the user should understand or do.

Exit conditions:

- Timeline labels read like an application UI, not protocol names.
- Status indicators are quiet for normal completed work and prominent for exceptional states.

## Milestone 4: Reasoning Renderer

Status: Complete

Failing tests first:

- Reasoning with no summary/content is hidden.
- Reasoning with a summary renders as a compact collapsed block.
- Expanding reasoning shows the summary, not raw JSON.
- Debug mode can reveal the raw payload.

Implementation:

- Add a dedicated reasoning block renderer.
- Prefer summary/content fields from the app-server item.
- Keep the default view collapsed and compact.
- Do not synthesize reasoning text from raw payload JSON.

Exit conditions:

- Reasoning supports trust and inspection without dominating the conversation.
- Raw reasoning payloads are unavailable in default mode.

## Milestone 5: Web Search Renderer

Status: Complete

Failing tests first:

- `webSearch` search actions render as `Searched web for "query"`.
- Multiple web searches in one turn group into one compact block.
- Open-page actions render as `Opened page` with a URL/title when available.
- Raw web-search action JSON is hidden by default.

Implementation:

- Add app-server item type detection for `webSearch`.
- Extract search queries from structured `action` fields.
- Group repeated searches within the same turn.
- Render query chips or a compact list in an expandable block.
- Keep raw action payloads behind debug mode.

Exit conditions:

- Web search activity is understandable at a glance.
- The implementation remains generic to `webSearch`; it does not inspect for weather or any other prompt domain.

## Milestone 6: Command and File Renderers

Status: Complete

Failing tests first:

- Command execution blocks show a human title, command, cwd, status when relevant, and output in a bounded monospace region.
- File-change blocks show path and action summary, not raw payload JSON.
- Long command/output content does not expand the page uncontrollably.

Implementation:

- Reuse the approval-card command display direction for timeline command items.
- Add bounded output areas.
- Render cwd and exit/status metadata as secondary text.
- Render file paths and action summaries as structured rows.

Exit conditions:

- Command and file timeline items are readable without exposing raw app-server payloads.
- Long output remains contained on desktop and mobile.

## Milestone 7: Generic Structured Tool Renderers

Status: Complete

Failing tests first:

- MCP and dynamic tool calls render tool name, arguments summary, and result summary when available.
- Simple structured outputs can render as key-value summaries.
- Unknown complex payloads show a compact unsupported-item fallback with debug disclosure.

Implementation:

- Add protocol-aware renderers for:
  - `mcpToolCall`
  - `dynamicToolCall`
  - unknown item types
- Use a generic key-value/result summary only for shallow, readable structures.
- Avoid prompt-domain-specific renderers.

Exit conditions:

- Tool calls are recognizable and compact.
- Unknown protocol growth degrades gracefully.

## Milestone 8: Turn Grouping

Status: Complete

Failing tests first:

- Events with the same `turnId` render as one turn group.
- The group preserves user message, assistant message, and tool activity order.
- Tool activity is visually subordinate to chat messages.
- Switching threads resets turn grouping correctly.

Implementation:

- Group presentation blocks by `turnId`.
- Render each turn as a coherent conversation/work unit.
- Keep assistant and user messages visually dominant.
- Nest web search, command, file, and tool activity inside the turn group.

Exit conditions:

- A thread with many app-server events reads as a sequence of turns, not a flat log stream.
- The weather/web-search thread becomes scan-friendly without losing tool context.

## Milestone 9: Debug Mode

Status: Complete

Failing tests first:

- Raw payload JSON is absent by default.
- Enabling debug mode reveals hidden lifecycle events and raw payload disclosures.
- Debug mode can be toggled from the UI without changing persisted gateway state.

Implementation:

- Add a local UI toggle, likely in the existing `Status` menu:
  - `Show debug events`
- When disabled:
  - hide raw payloads
  - hide empty lifecycle events
  - hide item IDs and protocol method names
- When enabled:
  - show hidden events
  - expose item ID, event kind, app-server method, and raw payload behind per-block disclosure controls

Exit conditions:

- Normal users get a clean Codex-like timeline.
- Developers can still inspect protocol behavior when debugging.

## Milestone 10: Fixed Thread Header and Message Scroll Region

Status: Complete

Failing tests first:

- The selected thread title remains visible when the message timeline scrolls.
- Thread actions such as resume, fork, archive, and relevant status/meta controls remain outside the message scroll container.
- Scrolling the message list does not scroll away the thread cwd/source/status metadata.
- Mobile layout preserves the same separation between thread header, scrollable messages, and bottom composer.

Implementation:

- Split the current thread panel into:
  - fixed thread header with title, path/source/status metadata, and thread actions
  - scrollable message/timeline region
  - composer region outside the timeline scroll container
- Keep the scroll container focused only on conversation and tool blocks.
- Ensure thread header controls do not overlap long generated titles.
- Keep the header compact enough to match the Codex desktop app layout.

Exit conditions:

- Thread title and actions remain visible during long timeline scrolls.
- Message scrolling is independent from project/sidebar and approval panel scrolling.
- Long thread titles truncate or wrap cleanly without pushing actions offscreen.

## Milestone 11: Timeline Density and Responsive Polish

Status: Complete

Failing tests first:

- Long search/tool/command blocks remain bounded in desktop and mobile viewports.
- Chat messages remain visible and readable when many tool blocks exist.
- Mobile timeline does not horizontally overflow with long queries, commands, URLs, or JSON debug payloads.

Implementation:

- Add compact nested tool styling.
- Tune spacing so chat messages have more emphasis than tool activity.
- Use collapsible sections for grouped searches and debug payloads.
- Ensure long tokens wrap or scroll inside bounded regions.

Exit conditions:

- The weather/web-search thread no longer appears chaotic.
- The timeline remains usable on desktop, tablet, and mobile.
- No raw JSON is shown unless debug mode is enabled.

## Review Gate

- Run `cd apps/web && npm test`.
- Run `cd apps/web && npm run build`.
- Use the running full-stack app to inspect at least one event-heavy thread on desktop and mobile.
- Perform an independent review pass or self-review for each implementation chunk.
- Do not mark this plan complete until all milestones above are implemented and [plans/index.md](index.md) is updated.
