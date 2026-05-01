# Image Attachments Plan

## Scope

Support sending images end to end from the Kodex web composer through the Rust gateway to Codex app-server. Users can attach images with the composer attachment button or by dragging image files onto the composer. Sent images render above the user message bubble as thumbnail squares.

This plan uses the checked-in app-server schema as the source of truth. App-server `turn/start` and `turn/steer` accept `UserInput[]`, including text, remote image URL, and local image path inputs. The gateway should expose that contract through generated OpenAPI and should avoid handwritten frontend DTO duplication.

## Status

Complete.

## Principles

- Red first where practical: start backend and frontend behavior with failing route/component tests.
- Preserve the app-server input contract: forward `{ type: "text" }`, `{ type: "image" }`, and `{ type: "localImage" }` inputs without converting them into Responses API content item shapes.
- Keep image storage local/VPN scoped. Gateway uploads are local helper assets, not a public file hosting surface.
- Keep the composer compact. Pending attachments live in a small tray above the textarea.
- Keep sent chat readable. Image thumbnails render above the user message bubble, not inside the text bubble.
- Defer generalized attachments, non-image files, and clipboard paste unless they fall out naturally from the same attachment state.

## Current Problem

The gateway currently accepts turn input as opaque JSON values and forwards them to app-server. This is enough for raw pass-through but generates weak frontend types. The web client only constructs text inputs, so there is no way to add image files from the browser, upload them to a gateway-visible local path, or render image inputs in the user timeline.

## Milestone 1: Gateway Input Contract

Status: Complete

Failing tests first:

- `POST /v1/threads/:threadId/turns` accepts mixed text and `localImage` inputs and forwards them unchanged to app-server.
- `POST /v1/threads/:threadId/turns/:turnId/steer` accepts mixed text and `localImage` inputs and forwards them unchanged to app-server.
- Invalid turn input is rejected before reaching app-server.
- Generated OpenAPI exposes typed turn input variants instead of `unknown[]`.

Implementation:

- Add a typed `UserInput` enum for text, remote image URL, local image path, skill, and mention inputs supported by the checked-in app-server schema.
- Update `TurnStartRequest` and `TurnSteerRequest` to use `Vec<UserInput>`.
- Keep gateway-to-app-server requests app-server-shaped.
- Keep app-server schema validation in place as the final contract check.

Exit conditions:

- Backend route tests cover text plus image input forwarding and invalid input rejection.
- OpenAPI includes typed turn input schemas.

## Milestone 2: Gateway Image Uploads

Status: Complete

Failing tests first:

- `POST /v1/uploads/images` accepts one or more multipart image files.
- The endpoint rejects non-image files.
- The endpoint rejects oversized image files.
- Upload responses return local absolute paths usable as app-server `localImage` inputs.
- The upload route appears in OpenAPI.

Implementation:

- Add an uploads route module.
- Accept multipart form uploads under the `images` field.
- Validate content type starts with `image/`.
- Enforce a conservative max file size.
- Store files under a gateway-owned directory that Codex app-server can read from its sandbox. The default is `/tmp/kodex/uploads/images`; `KODEX_UPLOADS_DIR` can override this when the chosen path is app-server-readable.
- Generate stable random filenames and preserve only a safe extension derived from MIME type.
- Return `ImageUploadResponse` with id, original file name, MIME type, size, and absolute local path.

Exit conditions:

- Uploaded files are written only under the configured gateway uploads directory.
- Non-image and oversized uploads fail with `400 Bad Request`.
- The route is documented through generated OpenAPI.

## Milestone 3: Composer Attachment UX

Status: Complete

Failing tests first:

- Clicking the composer attachment button opens image selection.
- Selected images render as square pending thumbnails above the textarea.
- Removing a pending thumbnail removes only that image.
- Dragging image files over the composer dims it and shows `Drop images to attach`.
- Dropping image files appends them to the pending attachments.
- Sending with text and images uploads the images and posts text plus `localImage` inputs.
- Sending images without text is allowed.

Implementation:

- Add a paperclip icon button to the composer.
- Add a hidden `input type="file"` with `accept="image/*"` and `multiple`.
- Track pending attachments with id, `File`, object URL, status, optional uploaded path, and optional error.
- Render a compact thumbnail tray above the textarea.
- Make the composer shell the drag target.
- Upload pending images on send, then call start or steer with text plus `localImage` inputs.
- Revoke object URLs when attachments are removed or cleared.

Exit conditions:

- Composer send is enabled when text exists or at least one image is attached.
- Drag and drop feedback is visible and scoped to the composer.
- Failed uploads leave attachments visible with retryable error state.

## Milestone 4: Timeline Image Rendering

Status: Complete

Failing tests first:

- User message items with image inputs render thumbnails above the user bubble.
- Image-only user messages render a right-aligned thumbnail grid without an empty text bubble.
- Thumbnail layout remains compact on desktop and mobile.

Implementation:

- Extend timeline item extraction to preserve user input image parts from app-server payloads.
- Render image thumbnails above the user message bubble.
- Use local object URLs for optimistic pending messages only if needed; otherwise rely on app-server event payload paths or gateway preview URLs.
- Defer full-screen preview unless it stays small and does not block the main flow.

Exit conditions:

- Sent images are visible in the timeline as square thumbnails above the user's message.
- Text-only messages keep their current rendering.

## Milestone 5: Verification And Review

Status: Complete

Implementation:

- Regenerate frontend OpenAPI types after gateway OpenAPI changes.
- Run backend formatting, clippy, and tests.
- Run frontend unit/component tests.
- Run the review-fix loop until no major issues remain.
- Update README if storage path, limits, or local-only security assumptions change.

Exit conditions:

- `CARGO_TARGET_DIR=/tmp/kodex-target cargo fmt --check`
- `CARGO_TARGET_DIR=/tmp/kodex-target cargo clippy --all-targets -- -D warnings`
- `CARGO_TARGET_DIR=/tmp/kodex-target cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Independent review reports no major issues remain.
