# File Preview Serving Plan

## Scope

Render file previews that appear in Codex app-server thread output. The first implementation supports browser-loadable image sources, local image paths, and local Markdown file links. The browser should display direct image data URLs when available, fetch local image paths through one thread-scoped gateway preview endpoint, and rewrite local Markdown references to that same endpoint as links.

This plan does not expand composer uploads or add general file attachments. For the initial implementation, the preview endpoint intentionally allows any local path that resolves to a supported regular file readable by the gateway process. This is a convenience tradeoff for localhost/trusted-VPN use, not a public-safe filesystem authorization model.

Future iterations may add inline Markdown handling, code, logs, or other text-like previews through the same endpoint, with type-specific limits and rendering.

## Status

Complete.

## Source Of Truth

Use the checked-in app-server schemas under `apps/gateway/app-server-schema/<version>/json` for supported payload shapes. The concrete image cases already observed are:

- `imageGeneration` thread items with base64 `result`, optional `revisedPrompt`, and optional `savedPath`.
- Raw `image_generation_call` response items with base64 `result`, optional `revised_prompt`, and `status`.
- `imageView` thread items with a local `path`.
- Tool output content items containing `input_image`/`inputImage` content with a browser-loadable `image_url`.

Markdown references are path-backed local files referenced by timeline/tool output payloads. This first iteration only treats `.md` and `.markdown` regular files as supported Markdown link targets. The frontend keeps them as links instead of rendering their contents inline.

## Principles

- Prefer direct rendering when an image payload already contains `data:`, `blob:`, or `http(s)` image URLs.
- Treat model-provided local paths as untrusted input.
- Use one thread-scoped file preview route instead of separate image, Markdown, and future code routes.
- Initial implementation accepts any local path that canonicalizes to a supported regular file readable by the gateway process.
- Support inline rendering only for images in this iteration.
- Support Markdown only as rewritten links that point at the thread-scoped file preview endpoint.
- Keep the endpoint typed with canonicalization, regular-file checks, content validation, type-specific size limits, and generic denial responses.
- Do not describe this endpoint as safe for public exposure; it is suitable only for localhost or trusted VPN deployment assumptions.
- Keep unavailable image previews visible as timeline placeholders rather than dropping the item.
- Keep Markdown references visible as links. If the gateway later rejects the target, the link request should fail with the normal generic response.
- Keep the renderer generic enough for observed image cases, but defer Markdown inline rendering and broader media support until new cases appear.

## Current Problem

The timeline can already extract and render several image-like payloads when they contain a browser-loadable `src`. Local absolute paths such as `/Users/...` cannot be loaded by the browser. Existing `displayableImageSrc` intentionally rejects those paths, so app-server `imageView` items and generated-image saved paths need a gateway-served preview URL.

The gateway currently supports `POST /v1/uploads/images`, but it does not expose a read endpoint for previewing local files referenced by thread output.

## Implementation Seams

Backend seams:

- Add `apps/gateway/src/routes/file_preview.rs` for the thread-scoped preview route instead of growing `routes/threads.rs`.
- Register the module in `apps/gateway/src/routes/mod.rs` and merge it from `apps/gateway/src/api.rs`.
- Add the OpenAPI path to `ApiDoc` in `apps/gateway/src/api.rs` and to the route-existence assertion in `apps/gateway/src/routes/mod.rs`.
- Add a query DTO such as `FilePreviewQuery { path: String }` in the new route module.
- Add an `UnsupportedMediaType` or equivalent variant to `apps/gateway/src/error.rs` if the implementation returns `415`; otherwise update this plan before implementation to use the existing `400`/`404` error surface.
- Keep file classification local to the new route module unless another preview route needs it. Use deterministic magic-byte sniffing for common image types plus `.md`/`.markdown` extension and UTF-8 validation for Markdown.
- Put focused route tests beside the existing route tests in `apps/gateway/src/routes/mod.rs`, matching the repository's current backend route-test pattern.

Frontend seams:

- Add a URL helper in `apps/web/src/api/client.ts`, for example `filePreviewUrl(threadId, path)`, so frontend code does not hand-roll API base URL handling.
- Extend `TimelineView` and `TimelineRowView` in `apps/web/src/timeline/TimelineView.tsx` to pass the selected `threadId` or a preview-url resolver down to renderers.
- Extend `TimelineRendererOptions` in `apps/web/src/timeline/renderers.tsx` with the selected thread context or URL resolver.
- Update `ImageActivityBlock` in `apps/web/src/timeline/renderers.tsx` to use the thread file preview URL when `item.path` is local and `item.imageSrc` is absent.
- Keep normal assistant message Markdown rendering in `AssistantMessageMarkdown` unchanged except for local `.md`/`.markdown` anchor href rewriting.
- Implement Markdown file link rewriting inside the existing `assistantMarkdownComponents.a` renderer in `apps/web/src/timeline/renderers.tsx`, because assistant message links are already centralized there.
- Keep user-uploaded optimistic image previews on the existing `imagePreviewUrlsByPath` object-URL path; do not route those local object URLs through the gateway.
- Add focused coverage in `apps/web/src/timeline/renderers.test.tsx` and presentation coverage in `apps/web/src/timeline/reducer.presentation.test.ts` only if the normalizer starts emitting new preview asset fields.

## End-To-End Flow

1. App-server emits a thread item or raw response item that contains image data, an image URL, a local image path, or a local Markdown link.
2. Frontend timeline normalization keeps using the existing image fields where possible: `TimelineItem.imageSrc`, `TimelineItem.path`, and `TimelineImage`.
3. The renderer uses direct image sources when they are browser-loadable.
4. If an image item has a local `path`, the renderer builds a thread-scoped preview URL:
   - `GET /v1/threads/{threadId}/files/preview?path=<encoded absolute path>`
5. If an assistant Markdown link points at a local `.md` or `.markdown` path, the existing assistant Markdown anchor renderer rewrites the href to the same thread-scoped preview URL and keeps it as a download link.
6. The gateway verifies that the thread exists, canonicalizes the requested path, confirms it is a supported regular file within the preview size limit, and returns the bytes or Markdown text.
7. If an image path is denied or unavailable, the frontend renders a compact unavailable-preview placeholder with the file name/path. Markdown link failures are handled by the browser request for now.

## Milestone 1: Gateway File Preview Endpoint

Status: Complete

Failing tests first:

- `GET /v1/threads/:threadId/files/preview` serves a readable local image path.
- The endpoint serves images from project, upload, generated-image, and temporary directories without requiring root-specific allow-listing.
- The endpoint serves a readable local `.md` file as Markdown.
- The endpoint serves a readable local `.markdown` file as Markdown.
- The endpoint rejects unknown threads, missing files, directories, oversized files, unsupported file types, and binary files that fail image validation.
- The endpoint rejects malformed paths and symlink escapes only insofar as the canonical target is unavailable or not a supported regular file.

Implementation:

- Add a route under the thread API:
  - `GET /v1/threads/{threadId}/files/preview?path=...`
- Verify `threadId` exists so previews stay tied to thread UI routes.
- Canonicalize the requested path.
- Reject directories and non-files.
- Classify the canonical file as one of:
  - image, based on content sniffing or validation; do not rely only on file extensions
  - Markdown, based on `.md` or `.markdown` extension plus UTF-8 text validation
- Enforce conservative type-specific preview size limits.
- Return image bytes with image `Content-Type`, `Content-Length` when known, and `Cache-Control: private`.
- Return Markdown as UTF-8 `text/markdown; charset=utf-8`, `Content-Length` when known, `Content-Disposition: attachment`, and `Cache-Control: private`.
- Return `404` or `415` for denied paths without exposing extra filesystem detail.

Exit conditions:

- Backend route tests cover valid image paths, valid Markdown paths, and denied unsupported/unavailable paths.
- The route is represented in generated OpenAPI.
- The endpoint is documented as an image/Markdown preview service that is intentionally local/VPN-scoped and not public-safe.

## Milestone 2: Frontend Image And Link Normalization

Status: Complete

Failing tests first:

- Raw `image_generation_call` response items normalize to an existing image field with a `data:image/png;base64,...` source.
- App-server `imageGeneration` thread items normalize to existing `imageSrc`, `resultSummary`, and optional `path` fields.
- `imageView` thread items continue to normalize to a path-backed image item.
- Tool output content containing `input_image`/`inputImage` normalizes to a browser-loadable image source.
- Assistant Markdown links whose href is a local `.md` or `.markdown` path are recognizable by the assistant anchor renderer.

Implementation:

- Reuse existing `TimelineItem.imageSrc`, `TimelineItem.path`, and `TimelineImage` fields where they already model the image cases.
- Keep image source extraction in `apps/web/src/timeline/presentationImages.ts` defensive and schema-shaped.
- Add a small helper near the renderer or API client to detect local Markdown hrefs: absolute paths ending in `.md` or `.markdown`.
- Do not add a broad preview asset abstraction unless implementation uncovers a repeated contract that the existing fields cannot express cleanly.

Exit conditions:

- Existing image renderers consume the existing timeline item/image fields.
- Markdown path link rewriting has focused frontend coverage.
- Unknown or malformed preview payloads do not crash the timeline.

## Milestone 3: Frontend Preview URL Rendering

Status: Complete

Failing tests first:

- Browser-loadable image sources render directly.
- Local image paths render through the thread-scoped file preview URL.
- Local Markdown paths stay as download links whose href points to the same thread-scoped file preview URL.
- Denied or failed previews show an unavailable-preview placeholder.
- The image lightbox uses the same resolved preview source as the thumbnail.

Implementation:

- Add a helper that resolves a local file path to a preview URL:

```ts
function filePreviewUrl(threadId: string, path: string): string {
  return `/v1/threads/${encodeURIComponent(threadId)}/files/preview?path=${encodeURIComponent(path)}`;
}
```

- Update `ImageActivityBlock`, `ImageThumbnail`, or their caller to use the helper for image previews.
- Update Markdown file reference rendering so local `.md` and `.markdown` references remain links, but their href points to the thread-scoped file preview URL and carries a `download` filename.
- Do not fetch and inline-render Markdown content in this iteration.
- Show a compact placeholder on preview load failure.
- Keep the path visible or copyable so the user understands what was referenced.

Exit conditions:

- Local-path images are displayable through the gateway.
- Local Markdown file references link through the gateway preview route and download/open the raw Markdown response when clicked.
- Non-showable previews have a stable, readable fallback.

## Milestone 4: Verification And Review

Status: Complete

Implementation:

- Regenerate OpenAPI after the gateway route is added.
- Regenerate frontend API types after OpenAPI changes.
- Run backend formatting and tests.
- Run focused frontend unit/component tests.
- Run a manual or browser-based smoke test against:
  - a generated base64 image result
  - a generated image saved under `~/.codex/generated_images`
  - an `imageView` path under the active project cwd
  - an image path under a temp directory
  - a Markdown path under a temp directory
  - a denied unsupported path
- Perform an independent review pass before completion.

Exit conditions:

- `cargo fmt --check`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Review finds no major rendering issues and confirms the intentional local/VPN-only security tradeoff is documented.

## Completion Notes

- Implemented thread-scoped `/v1/threads/{threadId}/files/preview` for local image previews and Markdown downloads.
- Added image content sniffing, Markdown UTF-8 validation, `415 Unsupported Media Type`, generated OpenAPI/frontend types, and README documentation for the local/VPN-only file-serving tradeoff.
- Updated timeline rendering so local image activity paths use the preview route, local Markdown links remain download links through the preview route, and raw `image_generation_call` items normalize to generated image timeline rows.
- Verified with `cargo fmt --check`, `cargo test -p kodex-gateway`, focused frontend timeline tests, `cd apps/web && npm test`, `cd apps/web && npm run build`, and an independent review/fix loop ending with no major issues.
