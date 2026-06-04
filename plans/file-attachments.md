# File Attachments Plan

## Context

Users should be able to attach non-image files in the web composer, type a normal message, and have Codex receive readable file paths while Kodex Web renders the message as text plus attachment items. This extends the completed [Image Attachments Plan](image-attachments.md) instead of replacing it.

Current image support is app-server-native: the web composer tracks pending image files, `uploadImages` posts multipart data to `POST /v1/uploads/images`, and `buildTurnInput` sends app-server `localImage` inputs. App-server does not expose a generic `file` user input. Upstream documents `mention` as app/plugin/connector selection, and the checked-in schema only supports `text`, `image`, `localImage`, `skill`, and `mention` user inputs. For non-image files, Kodex must send ordinary text that includes paths the model can read.

## Current State

- Gateway image uploads live in `apps/gateway/src/routes/uploads.rs`. They accept `images` multipart fields, validate image MIME/PNG bytes, write under the configured uploads directory, and return `ImageUploadResponse` with a local absolute path.
- Gateway turn input DTOs live in `apps/gateway/src/app_server_api/mod.rs` as `UserInput`. The enum has `Text`, `Image`, `LocalImage`, `Skill`, and `Mention`; there is no generic file variant.
- Browser sends are coordinated by `apps/web/src/composer/useComposerOrchestration.ts`. `pendingAttachments` is local React state, image files are uploaded inside `buildTurnInput`, and sent image inputs are appended as `{ type: "localImage", path }`.
- Pending image UI is `apps/web/src/composer/AttachmentTray.tsx`; drag, drop, paste, object URL, and preview helpers live in `apps/web/src/composer/attachmentUtils.ts`.
- Timeline image rendering depends on app-server content carrying image inputs. `apps/web/src/timeline/presentationImages.ts` extracts `image` and `localImage` payloads, and `TimelineItem.images` renders them beside the user message.
- Gateway visible text extraction in `visible_text_from_user_content` currently joins text inputs as-is. If Kodex appends a file path envelope to a text input, the envelope will become visible unless the gateway normalizes display text separately.
- Queued composer rows persist only `input_json` and options in `queued_turn_inputs`; `QueuedInput` currently has no attachment metadata field.

## Principles

- Keep app-server input app-server-shaped. Do not invent or rely on unsupported `UserInput::Mention` semantics for files.
- Send path-only context to Codex. The model-facing text should list readable paths and avoid MIME, size, upload ids, or UI metadata.
- Store structured attachment metadata in Kodex-owned DTOs/state so the UI can render attachment items without parsing arbitrary user text.
- Treat attachment envelopes as gateway-generated. Do not trust user-authored marker blocks as uploaded attachment state.
- Keep uploads local/trusted-network scoped, matching the existing gateway security model.
- Preserve existing image behavior: images should continue using native `localImage` inputs and thumbnails.

## Proposed Model-Facing Shape

For mixed text and non-image files, the gateway-generated app-server text should be:

~~~~text
<user message>

```kodex-attachments
- .kodex/uploads/<thread-id>/<upload-id>-report.pdf
- .kodex/uploads/<thread-id>/<upload-id>-data.csv
```
~~~~

The fenced block is only a transport envelope. Gateway display normalization strips this exact generated final block and exposes the paths through structured attachment metadata. The UI renders the user's text plus file items; Codex still sees the path list.

## Milestones

### 1. Gateway File Upload Contract

Scope: `apps/gateway/src/routes/uploads.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/config.rs`, `apps/gateway/src/routes/mod.rs`, OpenAPI generation, backend route tests.

Work:

- Add a thread-scoped non-image upload route, for example `POST /v1/threads/{threadId}/uploads/files`, that accepts multipart `files` fields.
- Return a typed response with upload id, original filename, extension, MIME type, size, absolute path, relative path from the thread cwd when available, and enough metadata for frontend rendering and cleanup.
- Resolve the target cwd from the thread/project metadata instead of trusting a browser-provided cwd.
- Write non-image uploads into the selected thread/project cwd under `.kodex/uploads/<thread-id>/`, with sanitized generated filenames.
- Keep existing `POST /v1/uploads/images` behavior unchanged for native app-server `localImage` inputs.
- Enforce conservative limits for file count, per-file bytes, total bytes per request, empty files, and path/name sanitization.
- Add route tests for successful upload, unsupported/oversized upload rejection, sanitized paths, and OpenAPI exposure.

Exit criteria:

- Backend tests prove uploads cannot escape the configured/project-local upload directory.
- OpenAPI exposes typed file upload request/response schemas.
- README documents the new project-local upload location and local/VPN-only assumptions.

### 2. Attachment Envelope And Metadata Projection

Scope: `apps/gateway/src/app_server_api/mod.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/store/queued_inputs.rs`, SQLite migrations.

Work:

- Add a gateway attachment metadata DTO, for example `TimelineFileAttachment`, with `id`, `fileName`, `extension`, `relativePath`, optional `absolutePath`, MIME, and size for UI/state use.
- Extend `TurnStartRequest`/`ThreadInputRequest` and queued-input creation with an optional gateway-only attachment metadata field that is not forwarded as an app-server `UserInput` variant.
- Add helper functions that append a deterministic `kodex-attachments` fenced path block to the last/only text input sent to app-server.
- Add helper functions that strip only gateway-known final attachment blocks from display text and return structured attachment metadata.
- Store attachment metadata with queued inputs instead of reconstructing it from text later. This likely needs a nullable `attachments_json` column on `queued_turn_inputs` and a `attachments` field on `QueuedInput`.
- Extend pending user projection so immediate timeline rows include display text without the envelope and include file attachments.
- Extend snapshot/live item normalization so app-server user messages containing a generated attachment block render with stripped text and file metadata after reload.
- Keep skill mention offsets based on stripped display text or explicitly reject attachment envelope interaction with skill ranges through tests.

Exit criteria:

- Backend unit tests cover envelope append, strip, user-authored fake markers ignored, metadata projection, and queued-input persistence.
- Existing image, skill mention, and queued-input tests still pass.
- Browser-visible timelines no longer display the generated attachment block.

### 3. Web Composer Mixed Attachment UX

Scope: `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/composer/types.ts`, `apps/web/src/composer/AttachmentTray.tsx`, `apps/web/src/composer/attachmentUtils.ts`, `apps/web/src/api/client.ts`, generated API types, composer tests.

Work:

- Generalize `PendingAttachment` from image-only to mixed file attachments with a `kind` such as `image` or `file`.
- Keep image attachments on the current native path: object URL thumbnail, `uploadImages`, then `localImage` input.
- Add non-image file uploads through the new generated API client call before submit/queue.
- Send non-image attachment metadata to the gateway with the normal `/v1/threads/{threadId}/input` or queued-input request so the gateway can append the path envelope and persist metadata.
- Update the attachment picker to accept multiple files, not only `image/*`, while still showing image thumbnails for image files.
- Render non-image pending attachments in the same tray style as images, but as compact file tiles showing only extension and filename plus upload/error/remove controls.
- Update drag/drop and paste handling to accept non-image files through the same composer path, with copy that says files rather than images when mixed.
- Preserve retry behavior: failed uploads leave pending attachments visible with error state and do not clear the draft.

Exit criteria:

- Frontend tests cover selecting mixed image/file attachments, sending text plus files, file-only sends if allowed by current composer rules, failed upload retry, `/compact` rejection with any attachment, and active-turn queue behavior.
- Generated frontend API types are refreshed from gateway OpenAPI.
- The composer remains usable on desktop, narrow fine pointer, and narrow touch/mobile layouts.

### 4. Timeline And Queue Rendering

Scope: `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/presentation.ts`, timeline renderers, queued composer row rendering, image preview mappings, focused timeline tests.

Work:

- Add `TimelineFileAttachment` or equivalent frontend type sourced from generated gateway DTOs.
- Render non-image attachments near the user message in the same visual family and placement as image attachments, but as compact file tiles showing only extension and filename in normal mode.
- Preserve current image grid rendering and lightbox behavior.
- Update queued row previews so queued file attachments show stable file counts/names across tabs instead of relying on same-client object URLs.
- Ensure failed optimistic sends remove or reconcile file attachment rows the same way image/text sends do.

Exit criteria:

- Timeline tests cover user messages with text plus file attachments, file-only messages, snapshot reload stripping the envelope, queued-row rendering, and image/file mixed messages.
- No generated attachment envelope text appears in normal timeline rendering.

### 5. Verification And Review

Scope: backend, frontend, docs, browser validation.

Work:

- Regenerate OpenAPI and frontend generated types after DTO/route changes.
- Run focused backend tests first, then broader `cargo test` when the implementation chunk is complete.
- Run frontend unit/component tests and build.
- Use `$agent-browser` to validate selecting files, sending mixed attachments, timeline rendering, queued active-turn behavior, upload failure display, and responsive composer behavior.
- Run an independent review pass before marking the plan complete.

Exit criteria:

- `cargo fmt --check`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Browser validation confirms the model-facing envelope is not visible in normal timeline UI while file attachment tiles are visible with extension and filename only.
- README and `plans/index.md` are updated for completed behavior/status changes.

## Risks And Open Questions

- Project-local uploads dirty the worktree. Mitigation: isolate files under `.kodex/uploads/` and document whether users should add that path to `.gitignore`; do not automatically edit project `.gitignore` without an explicit implementation decision.
- App-server snapshots only return text, not Kodex-owned metadata. Mitigation: make the envelope deterministic and parse only known/generated final blocks, with metadata repair from stored upload records where possible.
- Upload files may be unreadable under some permission profiles. Mitigation: prefer thread cwd-relative paths and include tests/docs around sandbox-readable locations.
- Large binary files can waste disk and context. Mitigation: send paths only to Codex, enforce byte/count limits, and avoid inline extraction in v1.
- Multi-client consistency depends on gateway-owned metadata. Mitigation: persist queued attachment metadata and emit canonical thread-view snapshots/patches; do not depend on one browser's local React state after upload succeeds.
