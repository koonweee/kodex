# Collaboration Agent Timeline Rendering Plan

## Status

Proposed.

## Goal

Make subagent activity legible in the web timeline by replacing raw receiver UUIDs with friendly agent names, formatting agent state as compact status UI, and rendering agent result snippets as Markdown. Keep the work scoped to frontend timeline presentation, derivation data, renderer components, styles, and focused tests.

## Scope

Included:

- Friendly display names for collaboration agents.
- Compact spawn, send, wait, resume, and close activity rendering.
- Markdown rendering for agent result snippets.
- Mobile-safe truncation and disclosure behavior.
- Focused reducer presentation and renderer tests.

Excluded:

- Gateway API changes.
- Persistent server-side agent-name state.
- New app-server contract docs.
- Agent picker, thread switching, or orchestration UX outside timeline rendering.

## Current Code Grounding

- Raw app-server collaboration payloads are normalized in `apps/web/src/timeline/presentationCollab.ts`.
- `createPresentationItem` in `apps/web/src/timeline/presentation.ts` stores only string fields today: `text`, `argsSummary`, `resultSummary`, and `toolName`.
- `CollabAgentBlock` in `apps/web/src/timeline/renderers.tsx` currently renders:
  - title text
  - `Details: {argsSummary}`
  - `Result: {resultSummary}`
- `TimelineItem` in `apps/web/src/timeline/state.ts` does not yet have structured collab-agent presentation fields.
- `reducer.presentation.test.ts` covers wait completion and failed spawn normalization.
- `renderers.test.tsx` covers grouped collab activity only lightly; standalone and structured rendering cases are missing.
- The checked-in app-server schema includes `CollabAgentStatus` values such as `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown`, and `notFound`.
- The schema also exposes optional subagent metadata fields including `agent_nickname`, `agent_role`, `agentNickname`, and `agentRole`; use them opportunistically without requiring them.

## Codex TUI Reference

Reference sources:

- Upstream TUI `multi_agents.rs`: https://github.com/openai/codex/blob/main/codex-rs/tui/src/multi_agents.rs
- Upstream TUI `chatwidget.rs`: https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget.rs
- Checked-in app-server schema: `apps/gateway/app-server-schema/0.128.0/json/codex_app_server_protocol.v2.schemas.json`

Useful TUI patterns to adapt:

- Keep a `ThreadId -> AgentMetadata` cache with `agent_nickname` and `agent_role`.
- Format agent picker and timeline labels as `nickname [role]` when both are known, `nickname` when only nickname is known, `[role]` when only role is known, and `Agent` only as a final fallback.
- Cache spawn request model/reasoning so completed spawn rows can still show `(model reasoning)` even if later events omit those fields.
- Suppress noisy in-progress spawn rows until there is something useful to show.
- Render wait completion as one line per agent with a readable label, status, and truncated message.
- Translate raw states into readable labels such as `Pending init`, `Running`, `Completed`, `Error`, `Shutdown`, and `Not found`.
- Truncate prompt previews and result previews rather than letting long agent output dominate the timeline.
- Keep raw IDs available only through verbose/debug surfaces.

Do not copy the TUI rendering literally. The web timeline should use React components, chips, Markdown previews, and responsive CSS instead of terminal bullet formatting.

## Data Model Direction

Add structured optional fields to `TimelineItem` rather than overloading `argsSummary` and `resultSummary` further:

```ts
type TimelineCollabAgent = {
  threadId: string;
  displayName: string;
  nickname?: string;
  role?: string;
  status?: string;
  rawStatus?: string;
  message?: string;
};

type TimelineCollabAgentPresentation = {
  agents: TimelineCollabAgent[];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
};
```

Store this on `TimelineItem` as something like `collab?: TimelineCollabAgentPresentation`.

Keep `argsSummary` and `resultSummary` during migration only if existing tests or fallback renderers need them. New UI should read structured fields first.

## Friendly Name Rules

Resolve display names in this order:

1. `agent_nickname` or equivalent camelCase field from app-server payload.
2. Agent role plus ordinal, for example `Explorer 1` or `Worker 2`.
3. Prompt-derived role only if simple and deterministic, for example `Renderer inspector` from a short read-only inspection prompt. Avoid fragile NLP for the first implementation unless the prompt clearly starts with a role/name.
4. Stable ordinal by first spawn order within the timeline, for example `Agent 1`, `Agent 2`.
5. Short UUID only in debug or tooltip fallback, never as primary visible text.

Use the receiver thread ID as the internal key. Rebuild the mapping from timeline events when thread detail loads so no server persistence is required.

## UX Direction

Collapsed group summary:

- `Used 2 agents`
- Children:
  - `Spawned Lorentz`
  - `Spawned Mill`
  - `Waiting for 2 agents`
  - `Finished waiting`

Spawn row:

- Title: `Spawned Lorentz`
- Chips: `5.5`, `High`, `Starting`
- Prompt preview: one or two lines, clamped on mobile.

Wait running row:

- Title: `Waiting for 2 agents`
- Agent rows:
  - `Lorentz - Running`
  - `Mill - Starting`

Wait completed row:

- Title: `Finished waiting`
- Agent rows:
  - `Lorentz - Completed`
  - Markdown preview of the completion message, clamped.
  - `Mill - Completed`
  - Markdown preview of the completion message, clamped.

Failed or errored rows:

- Use danger tone for `failed`, `errored`, and `notFound`.
- Show a concise error preview.
- Keep raw payload in debug details.

## Milestone 1: Structured Presentation Data

Failing tests first:

- `spawnAgent` with `agent_nickname` and `agent_role` produces a collab presentation object with `displayName`, `role`, `model`, `reasoningEffort`, and prompt.
- `wait` with `agentsStates` resolves the same friendly names by receiver thread ID.
- Multiple receiver IDs without nicknames get stable `Agent 1`, `Agent 2` display names.
- Raw UUIDs remain present in debug payloads but not in primary presentation strings.

Implementation:

- Extend `TimelineItem` with a focused `collab` presentation field.
- Replace or supplement `collabAgentArgsSummary` and `collabAgentResultSummary` with structured helpers:
  - `collabAgentPresentation(item, existingAgentNameMap?)`
  - `collabAgentDisplayName(...)`
  - `collabAgentStatusLabel(...)`
- Preserve current string fields as temporary fallbacks where needed.
- Keep all raw payload interpretation inside `presentationCollab.ts`.

Exit conditions:

- Reducer presentation tests cover friendly names and status translation.
- No gateway API or OpenAPI changes.

## Milestone 2: Renderer Layout

Failing tests first:

- Standalone `collab_agent_tool_call` renders `Spawned Lorentz`, model/reasoning chips, and a prompt preview.
- Wait completion renders one row per agent with friendly names and readable statuses.
- UUIDs do not appear in normal renderer output.
- Markdown result content renders bold text, lists, code spans, and local Markdown links through the same safe markdown conventions used by assistant content where practical.
- Long prompt/result content is clamped or contained on mobile.

Implementation:

- Replace `CollabAgentBlock`'s prose `Details:` / `Result:` layout with structured rows.
- Add small components if needed:
  - `CollabAgentChips`
  - `CollabAgentResultList`
  - `CollabAgentMarkdownPreview`
- Reuse existing `ReactMarkdown`, `remark-gfm`, and `remark-breaks` patterns.
- Keep raw IDs in `title` attributes or debug only; avoid visible UUID text.
- Add CSS under `apps/web/src/styles/timeline.css` for compact agent rows, chips, and line clamps.

Exit conditions:

- The mobile view no longer shows UUID-heavy paragraphs.
- Result Markdown is legible and contained.
- Existing grouped activity behavior still works.

## Milestone 3: Activity Summaries And Grouping

Failing tests first:

- `activityItemSummary` uses friendly agent names for single-agent rows.
- Multi-agent wait summaries prefer counts, for example `Waiting for 2 agents`.
- Completed wait rows summarize completion without raw IDs.

Implementation:

- Update `activityItemSummary` for `collab_agent_tool_call`.
- Keep `activityGroupSummary` count-based: `Used 1 agent`, `Used 2 agents`.
- Ensure long collab titles use the same truncation behavior recently added for command summaries.

Exit conditions:

- Collapsed rows are understandable without expansion.
- Icons, badges, and carets do not get squeezed by long prompts or result text.

## Milestone 4: TUI Parity Check And Verification

Review checklist:

- Compare against TUI `multi_agents.rs` after implementation.
- Confirm web covers:
  - nickname plus role labels
  - spawn model/reasoning
  - wait begin and wait completion
  - send input
  - resume
  - close
  - pending/running/completed/error/shutdown/not-found statuses
  - truncated prompt/result previews
- Confirm any TUI-only affordances, such as agent picker navigation, are intentionally out of scope.

Verification commands:

- `cd apps/web && npm test -- reducer.presentation.test.ts renderers.test.tsx`
- `cd apps/web && npm run build`

Manual QA:

- Run two subagents from a timeline turn.
- Inspect spawn rows while pending.
- Inspect wait row after one agent completes.
- Inspect final completed wait row on mobile width.
- Confirm UUIDs are hidden from normal view and remain available in debug details.

## Risks

- Agent metadata may be absent in some payloads. Stable ordinals must be deterministic across replay.
- Prompt-derived roles can become misleading. Prefer real nickname/role metadata and ordinal fallback first.
- Markdown result snippets may contain file links or long code spans. Use existing safe markdown rendering and mobile clamping.
- Changing `TimelineItem` shape can touch tests broadly. Keep the field optional and localized.
- Multiple spawn events for the same receiver thread should not change a name once assigned unless a real nickname arrives later.
