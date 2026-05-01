# MVP Frontend Implementation Plan

## Scope

Build the first Kodex web client in React. The client consumes the Rust gateway HTTP and SSE APIs. It is not the source of truth for sessions or events; it renders gateway state and sends user actions. The design must keep future desktop, mobile, CLI, or extension clients possible.

Current implementation note: `apps/web` now contains the Vite/Mantine React client, generated OpenAPI TypeScript types, typed gateway client wrappers, SSE reconnect support, timeline renderer registry, project/thread navigation, composer and steering controls, approvals, account/model controls, and Vitest plus Playwright coverage for the MVP flows.

## Principles

- Red first: each UI feature starts with a failing component test, reducer test, API-client test, or Playwright flow.
- DRY: use one API client, one SSE event client, one event reducer, and one timeline renderer registry.
- YAGNI: do not add a complex global state framework, terminal emulator, file editor, plugin marketplace, or automations UI in MVP.
- Documentation is part of done: update `README.md`, `AGENTS.md`, and [plans/index.md](index.md) when commands, conventions, or plan status change.

## Stack

- React with Vite and TypeScript under `apps/web`.
- Vitest and Testing Library for unit/component tests.
- Playwright for end-to-end flows.
- Mantine for maintained UI primitives and layout components.
- `lucide-react` for icons.
- Fetch-based API client.
- Browser `EventSource` for SSE.
- React Query or a small local query layer for request caching. Add a larger state library only after reducer/query state becomes hard to manage.
- Generated TypeScript API types/client from gateway `/openapi.json` using `openapi-typescript` or an equivalent generator.

## Component Ownership

- Use Mantine components for generic UI primitives such as buttons, forms, drawers, modals, popovers, tooltips, menus, tabs, badges, loaders, alerts, layout helpers, and empty/error states.
- Use `lucide-react` icons inside icon buttons and status affordances instead of maintaining custom icon SVGs.
- Own only Kodex-specific components: app shell composition, project/thread navigation, timeline renderer registry and renderers, composer behavior, approval flows, account/model surfaces, and gateway-specific state wiring.
- Prefer theming and composition over copying third-party component implementations into the repo.
- Add custom primitives only when the component library cannot reasonably express the required interaction or when repeated Kodex-specific behavior justifies it.

## Milestone 0: Frontend Scaffold

Status: Complete

Failing tests first:

- App shell test fails before implementation.
- Mocked `GET /v1/capabilities` renders gateway status.
- API type generation command fails before OpenAPI input or generated output is wired.

Implementation:

- Create `apps/web`.
- Add Vite React TypeScript setup.
- Add test setup.
- Add Mantine and `lucide-react`.
- Add a minimal app theme and provider setup.
- Add generated API types/client directory.
- Add API client module that wraps generated types instead of handwritten duplicate DTOs.
- Add app layout:
  - left sidebar
  - main thread panel
  - bottom composer placeholder
  - right approval drawer placeholder

Documentation:

- Add frontend commands to `README.md`.
- Add frontend test conventions to `AGENTS.md`.
- Document how to regenerate frontend API types from gateway OpenAPI.

Exit conditions:

- Frontend test command passes.
- App shell renders against mocked capabilities data.
- API type generation command exists and is documented.
- The generated API directory is ignored or committed according to the documented convention.
- `README.md` and `AGENTS.md` include the frontend commands needed by the next milestone.

## Milestone 1: Project and Thread Navigation

Status: Complete

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
- `GET /v1/threads?projectId=` returns typed `threads`, cursor fields, and `rawPayload` for diagnostics only.
- `POST /v1/threads`, `GET /v1/threads/:threadId`, `POST /v1/threads/:threadId/resume`, and `POST /v1/threads/:threadId/fork` return typed thread metadata needed by the UI.
- `POST /v1/threads/:threadId/archive`

YAGNI boundaries:

- No project settings page.
- No repo clone flow.
- No multi-user workspace switcher.
- No handwritten TypeScript DTO duplicates for gateway API responses.

Exit conditions:

- Project and thread navigation tests pass with mocked generated-client responses.
- Users can create/select a project and see its threads.
- Users can create, resume, fork, and archive a thread from the UI shell.
- Loading, empty, and error states are present for project/thread lists.
- No handwritten gateway response DTOs are introduced.

## Milestone 2: Event Stream and Timeline Reducer

Status: Complete

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
- Generated event envelope type from OpenAPI for the initial event shape. Codex raw payloads may remain `unknown` until normalized by specific renderers.

DRY boundaries:

- One event reducer.
- One delta aggregation path.
- One renderer registry.

Exit conditions:

- Event reducer tests pass for replay, deltas, item start, item completion, and turn completion.
- SSE client reconnects from the last seen sequence in tests or controlled mocks.
- Timeline renders MVP item types without crashing on unknown raw payloads.
- Warning and error events are visible in the timeline or global banner.
- Event rendering uses the shared renderer registry.

## Milestone 3: Composer and Turn Controls

Status: Complete

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

Exit conditions:

- Composer tests pass for submit, disabled state, stop, and steer when active.
- Composer sends generated-client-compatible payloads.
- Model picker is populated from mocked model data.
- Active turn state is visible and stop action is reachable.
- No image upload, slash-command, or template framework is added.

## Milestone 4: Approval UI

Status: Complete

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

Exit conditions:

- Approval UI tests pass for pending, accept, decline, and resolved states.
- Command, file-change, permission, MCP elicitation, and tool user-input approval shapes have renderers.
- Approval drawer and inline approval cards both use the same approval state.
- Decision submissions use generated-client-compatible payloads.
- Resolved approvals leave the pending view without requiring a full page reload.

## Milestone 5: Account and Models

Status: Complete

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

The frontend should consume the generated gateway DTOs for account, login start, rate limits, and model list directly. Stable MVP fields are first-class backend fields; do not add frontend normalizers that parse them out of opaque app-server payloads.

Documentation:

- Document that gateway access is trusted-network-only.
- Document that ChatGPT login is only for Codex/OpenAI account state.

Exit conditions:

- Account/model tests pass for unauthenticated, login URL, authenticated, rate-limit, and model-picker states.
- Login, cancel, logout, account refresh, and model list actions are wired to the API client.
- Rate-limit indicator handles missing optional fields.
- Documentation includes the trusted-network and ChatGPT-auth distinction.
- Model picker remains usable if hidden models are excluded.

## Milestone 6: MVP Polish and E2E

Status: Complete

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
- Ensure frontend API generation is included in documented dev and CI commands.

Exit conditions:

- Playwright MVP flows pass against mocked or local gateway endpoints.
- Full frontend build succeeds.
- Built assets can be served by the gateway static-serving milestone.
- SSE reconnect and loading/error states are visibly handled.
- README documents full-stack run, frontend test, E2E test, and API type generation commands.
