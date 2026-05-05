# Chat Sidebar Plan

## Scope

Add a first-class Chats section to the web sidebar. Chats are normal Codex app-server threads, but the gateway owns their working-directory convention instead of requiring the user to create or select a project.

This plan also polishes the project creation affordance by renaming "New project" and "Create project" to "Add project", changing the project-add icon to a folder-add icon, and making project row styling quieter so project names read like navigation labels instead of section headers.

## Status

Proposed

## UX Contract

- The Projects section remains the place for explicit project directories.
- The project add action and submit button both say "Add project".
- The project add icon uses a folder-add icon from `lucide-react` if available.
- Project names render exactly as `project.name`.
- Project rows use the same subtle navigation scale as thread rows.
- The project add icon and project folder icon are visually matched in size.
- The sidebar adds a Chats section near Projects.
- Chats are a flat list, not date-grouped.
- Chats show at most five threads by default.
- Chats reuse the existing "Show more" and "Show less" behavior used for project thread lists.
- The Chats "New chat" button uses the same visual treatment as a project's "New thread" button.
- Chat threads select, compose, stream, show unread state, show active state, show approval state, and archive like project threads.
- The first user message supplies the chat folder slug and optimistic display title source.

## Directory Contract

The gateway derives each new chat thread working directory on the gateway machine:

```text
~/Documents/Codex/<YYYY-MM-DD>/<thread-slug>
```

- `<YYYY-MM-DD>` comes from the gateway's local date at chat materialization time.
- The client does not compute or send the date.
- The gateway expands `~`, creates the directory, canonicalizes the path, and sends/stores the canonical absolute cwd, matching project cwd behavior.
- `<thread-slug>` is derived from the first user message:
  - normalize to lowercase kebab case
  - replace filesystem-hostile characters with separators
  - collapse repeated separators
  - trim leading and trailing separators
  - fall back to `untitled-chat` if nothing useful remains
  - cap the base slug at 80 characters before duplicate suffixes
  - resolve duplicate directories with suffixes such as `-2`, `-3`
- macOS filename components are typically limited to 255 bytes; the 80-character slug cap is intentionally conservative and keeps folders readable.

## Non-Goals

- No chat date grouping in the sidebar.
- No custom chat title input before the first message.
- No synthetic project rows for Chats.
- No public deployment/auth changes.
- No handwritten TypeScript gateway DTOs.
- No changes to the upstream app-server wire contract beyond the gateway continuing to call `thread/start` with a cwd.

## Milestone 1: Gateway Chat Thread API

Status: Proposed

Failing tests first:

- `POST /v1/chats/threads` creates the expected dated chat directory under the configured home directory.
- The created thread is started through app-server `thread/start` with a canonical cwd.
- Slug normalization handles punctuation, whitespace, casing, empty text, long text, and duplicate directories.
- `GET /v1/chats/threads` lists only threads whose cwd is under the chat root.
- Existing project `POST /v1/threads` behavior remains unchanged.

Implementation:

- Add a chat route module or extend the existing thread route module with explicit chat endpoints:
  - `GET /v1/chats/threads`
  - `POST /v1/chats/threads`
- Add request DTO for chat creation:
  - `firstMessageText: string`
  - existing thread creation options: model, service tier, approval policy, approvals reviewer, sandbox, and payload defaults
- Keep project thread creation on `POST /v1/threads` with required `projectId`.
- Add a gateway helper for chat cwd derivation and slug de-duplication.
- Use `chrono::Local` or an injectable date provider in the route helper so tests can pin the date.
- Create missing directories before calling app-server.
- Canonicalize cwd before passing it to `app_server_api::thread_start`.
- Reuse `apply_thread_read_state` for returned and listed chat thread summaries.
- Register new routes and `utoipa` paths so `/openapi.json` exposes the chat endpoints.

Exit conditions:

- Focused backend route/helper tests pass.
- Existing backend thread/project route tests pass.
- `cargo fmt` passes.
- `cargo test` passes for touched backend behavior.
- Generated OpenAPI includes the new chat endpoints and DTOs.

## Milestone 2: Frontend API Types and Client

Status: Proposed

Failing tests first:

- API client wrapper tests or app-flow mocks fail until chat list/create calls exist.
- TypeScript fails if chat DTOs are hand-written instead of generated.

Implementation:

- Regenerate `apps/web/src/api/generated/schema.ts` from gateway `/openapi.json`.
- Add typed wrappers in `apps/web/src/api/client.ts`:
  - `listChatThreads()`
  - `createChatThread(firstMessageText, options)`
- Keep `createThread(projectId, options)` for project threads.
- Do not duplicate gateway response interfaces outside generated OpenAPI types.

Exit conditions:

- Generated schema is committed with the DTO changes.
- Frontend API wrappers compile against generated types.
- Existing API wrapper consumers keep their current project-thread behavior.

## Milestone 3: Sidebar Structure and Styling

Status: Proposed

Failing tests first:

- Sidebar test expects "Add project" for both the icon label and form submit copy.
- Sidebar test expects a Chats section with a "New chat" button.
- Sidebar test expects only five chat threads before "Show more" is clicked.
- Sidebar test verifies project names render exactly.

Implementation:

- Update `apps/web/src/threads/WorkspaceSidebar.tsx` copy constants:
  - `newProject` -> "Add project"
  - project submit copy -> "Add project"
  - add `chats` and `newChat`
- Replace the project add header icon with `FolderPlus` from `lucide-react` when available.
- Reuse `ThreadListRow` for chat thread rows.
- Extract or reuse the thread-list collapse behavior so project thread lists and chat thread lists share the same five-item/show-more logic.
- Add props for chat thread data and handlers:
  - `chatThreads`
  - `onCreateChat`
  - `onSelectChatThread`
  - selected chat/thread state, if separate selection metadata is needed
- Adjust sidebar CSS so project rows use subtler typography and spacing aligned with thread rows.
- Keep project drag/reorder behavior intact.

Exit conditions:

- Focused sidebar tests pass.
- Existing project reorder tests still pass.
- No project/thread selection accessibility labels regress.

## Milestone 4: Frontend Chat Thread State

Status: Proposed

Failing tests first:

- App shell flow starts a chat draft from "New chat" without calling the API immediately.
- First send from a chat draft calls chat-thread creation, then starts the first turn on the returned thread.
- Chat thread optimistic title behavior matches project draft thread behavior.
- Selecting an existing chat thread loads, streams, queues, archives, and marks read like a project thread.

Implementation:

- Add `chatThreads` state beside `threadsByProjectId`.
- Add `draftChatThreadSelected` or an equivalent discriminated draft state so the composer can distinguish project drafts from chat drafts.
- Keep selected thread id as the canonical timeline/composer key.
- Add a selection context helper if needed:
  - project thread selection: `{ kind: "project", projectId, threadId }`
  - chat thread selection: `{ kind: "chat", threadId }`
- Extend draft materialization:
  - project draft uses `createThread(projectId, options)`
  - chat draft uses `createChatThread(firstMessageText, options)`
- After chat creation, prepend the returned thread to `chatThreads`, attach live stream handling, mark the title pending if needed, and start the first turn exactly like project drafts.
- Make archive removal search both project thread groups and chat threads.
- Load chat threads during initial shell load alongside projects and project threads.
- Keep composer settings hydration for project threads unchanged; for chats, use global/default settings until a thread-specific snapshot provides selected settings.

Exit conditions:

- Existing project thread draft tests still pass.
- New chat draft/materialization tests pass.
- Existing composer, queue, timeline, approval, read-state, and archive flows pass for project threads.
- Chat thread rows display active, unread, and approval indicators through existing row behavior.

## Milestone 5: Verification and Documentation

Status: Proposed

Implementation:

- Run backend checks:
  - `cargo fmt`
  - `cargo test`
- Run frontend checks:
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
- Run targeted browser QA if the sidebar layout changes are large enough to risk responsive regressions.
- Update `README.md` only if new commands, setup, or behavior need user-facing documentation.
- Update this plan with completion notes when implemented.
- Update `plans/index.md` status when work starts or completes.

Exit conditions:

- Automated checks pass.
- OpenAPI and frontend generated types are current.
- The active implementation status is reflected in `plans/index.md`.
- An independent review pass finds no major issues, or any major issues are fixed before completion.
