# MVP Frontend Implementation Plan

## Scope

Build the first Kodex web client in React. The client consumes the Rust gateway HTTP and SSE APIs. It is not the source of truth for sessions or events; it renders gateway state and sends user actions. The design must keep future desktop, mobile, CLI, or extension clients possible.

## Principles

- Red first: each UI feature starts with a failing component test, reducer test, API-client test, or Playwright flow.
- DRY: use one API client, one SSE event client, one event reducer, and one timeline renderer registry.
- YAGNI: do not add a complex global state framework, terminal emulator, file editor, plugin marketplace, or automations UI in MVP.
- Documentation is part of done: update `README.md`, `AGENTS.md`, and [plans/index.md](index.md) when commands, conventions, or plan status change.

## Stack

- React with Vite and TypeScript under `apps/web`.
- Vitest and Testing Library for unit/component tests.
- Playwright for end-to-end flows.
- Fetch-based API client.
- Browser `EventSource` for SSE.
- React Query or a small local query layer for request caching. Add a larger state library only after reducer/query state becomes hard to manage.

## Milestone 0: Frontend Scaffold

Status: Proposed

Failing tests first:

- App shell test fails before implementation.
- Mocked `GET /v1/capabilities` renders gateway status.

Implementation:

- Create `apps/web`.
- Add Vite React TypeScript setup.
- Add test setup.
- Add API client module.
- Add app layout:
  - left sidebar
  - main thread panel
  - bottom composer placeholder
  - right approval drawer placeholder

Documentation:

- Add frontend commands to `README.md`.
- Add frontend test conventions to `AGENTS.md`.

## Milestone 1: Project and Thread Navigation

Status: Proposed

Failing tests first:

- Project list renders from mocked API.
- Thread list renders name, preview, status, and updated time.
- Selecting a thread loads its detail.
- New thread action calls `POST /v1/threads`.

Implementation:

- Project sidebar.
- Thread list grouped under selected project.
- Empty state for no projects.
- New project form with cwd field.
- New thread button.
- Resume selected thread.
- Archive control.
- Fork control if a thread is selected.

API dependencies:

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/threads?projectId=`
- `POST /v1/threads`
- `GET /v1/threads/:threadId`
- `POST /v1/threads/:threadId/resume`
- `POST /v1/threads/:threadId/fork`
- `POST /v1/threads/:threadId/archive`

YAGNI boundaries:

- No project settings page.
- No repo clone flow.
- No multi-user workspace switcher.

## Milestone 2: Event Stream and Timeline Reducer

Status: Proposed

Failing tests first:

- Event replay populates timeline state.
- `item/agentMessage/delta` appends text to the correct item.
- `item/started` creates an item shell.
- `item/completed` replaces the item with completed payload.
- `turn/completed` marks active turn complete.

Implementation:

- SSE client with reconnect from last `seq`.
- Event reducer that consumes gateway events.
- Thread timeline state keyed by thread ID.
- Timeline renderer registry by item type and notification method.
- MVP renderers:
  - user message
  - agent message
  - reasoning
  - plan
  - command execution
  - file change
  - MCP tool call
  - dynamic tool call
  - warning
  - error

API dependencies:

- `GET /v1/events?cursor=&threadId=`

DRY boundaries:

- One event reducer.
- One delta aggregation path.
- One renderer registry.

## Milestone 3: Composer and Turn Controls

Status: Proposed

Failing tests first:

- Composer submits text to `POST /v1/threads/:threadId/turns`.
- Composer is disabled without an active thread.
- Stop button sends interrupt for active turn.
- Steering an active turn calls the steer endpoint when available.

Implementation:

- Text composer.
- Send button.
- Stop button.
- Active turn indicator.
- Basic model selector using `GET /v1/models`.
- Optional effort selector if the selected model exposes reasoning options.

API dependencies:

- `POST /v1/threads/:threadId/turns`
- `POST /v1/threads/:threadId/turns/:turnId/steer`
- `POST /v1/threads/:threadId/turns/:turnId/interrupt`
- `GET /v1/models`

YAGNI boundaries:

- No image upload in MVP unless needed to validate app-server input support.
- No slash-command framework.
- No prompt template library.

## Milestone 4: Approval UI

Status: Proposed

Failing tests first:

- Pending approvals render in the drawer.
- Command approval shows command, cwd, reason, and parsed actions when present.
- Accept posts the correct decision.
- Decline posts the correct decision.
- Resolved approval disappears from pending list.

Implementation:

- Approval drawer.
- Inline approval cards in timeline when `threadId` and `itemId` match.
- Renderers for:
  - command execution approval
  - file change approval
  - permission approval
  - MCP elicitation
  - tool user input
- Decision buttons:
  - accept
  - accept for session when available
  - decline
  - cancel when available
- Pending approval badge in sidebar.

API dependencies:

- `GET /v1/approvals?status=pending`
- `GET /v1/approvals/:approvalId`
- `POST /v1/approvals/:approvalId/decision`
- SSE events for `approval.created` and `approval.resolved`

YAGNI boundaries:

- No approval policy editor.
- No audit log page beyond event history.
- No notification integrations.

## Milestone 5: Account and Models

Status: Proposed

Failing tests first:

- Account panel renders unauthenticated state.
- Login action displays ChatGPT auth URL.
- Account panel renders authenticated state from `account/read`.
- Rate-limit indicator renders primary rate limit when present.
- Model picker uses `model/list`.

Implementation:

- Account popover or settings panel.
- ChatGPT login start and cancel.
- Logout.
- Rate-limit badge.
- Model picker metadata:
  - display name
  - description
  - default reasoning effort
  - hidden models excluded by default

API dependencies:

- `GET /v1/account`
- `POST /v1/account/login`
- `POST /v1/account/login/:loginId/cancel`
- `POST /v1/account/logout`
- `GET /v1/account/rate-limits`
- `GET /v1/models`

Documentation:

- Document that gateway access is trusted-network-only.
- Document that ChatGPT login is only for Codex/OpenAI account state.

## Milestone 6: MVP Polish and E2E

Status: Proposed

Failing tests first:

- Playwright can create/select a project against mocked gateway.
- Playwright can create a thread and submit a turn.
- Playwright can render streamed assistant output.
- Playwright can resolve a pending approval.

Implementation:

- Loading and error states.
- Reconnect banner for SSE.
- Empty states.
- Basic responsive layout.
- Keyboard submit shortcut.
- Build output consumed by gateway static serving.

Documentation:

- Update root `README.md` with full-stack dev and build commands.
- Update `apps/web/README.md` if created.
- Update [plans/index.md](index.md) status.

