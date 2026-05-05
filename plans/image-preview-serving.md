# Image Preview Serving Plan

## Scope

Render image previews that appear in Codex app-server thread output, including generated images and tool-viewed local images. The browser should display image data URLs directly and should fetch local file paths through a narrow gateway preview endpoint.

This plan is about showing images that already exist in model/app-server output. It does not expand composer uploads, add general file attachments, or turn the gateway into a broad local file server.

## Status

Proposed.

## Source Of Truth

Use the checked-in app-server schemas under `apps/gateway/app-server-schema/<version>/json` for supported payload shapes. The concrete image cases already observed are:

- `imageGeneration` thread items with base64 `result`, optional `revisedPrompt`, and optional `savedPath`.
- Raw `image_generation_call` response items with base64 `result`, optional `revised_prompt`, and `status`.
- `imageView` thread items with a local `path`.
- Tool output content items containing `input_image`/`inputImage` content with a browser-loadable `image_url`.

## Principles

- Prefer direct rendering when the payload already contains `data:`, `blob:`, or `http(s)` image URLs.
- Treat model-provided local paths as untrusted input.
- Serve only image files under roots that are valid for the current thread/project context or under gateway-owned media roots.
- Keep unavailable images visible as timeline placeholders rather than dropping the item.
- Keep the renderer generic enough for the observed image cases, but defer broader media support until new cases appear.

## Current Problem

The timeline can already extract and render several image-like payloads when they contain a browser-loadable `src`. Local absolute paths such as `/Users/...` cannot be loaded by the browser. Existing `displayableImageSrc` intentionally rejects those paths, so app-server `imageView` items and generated-image saved paths need a gateway-served preview URL.

The gateway currently supports `POST /v1/uploads/images`, but it does not expose a read endpoint for previewing local image files.

## End-To-End Flow

1. App-server emits a thread item or raw response item that contains image data, an image URL, or a local path.
2. Frontend timeline normalization extracts a `TimelineImageAsset`.
3. The renderer uses `asset.src` directly when it is browser-loadable.
4. If the asset only has `path`, the renderer builds a thread-scoped preview URL:
   - `GET /v1/threads/{threadId}/images/preview?path=<encoded absolute path>`
5. The gateway looks up the thread/project context, canonicalizes the requested path, checks it against allowed roots, verifies that the file is an image, and returns the bytes.
6. If the path is denied or unavailable, the frontend renders a compact unavailable-image placeholder with the file name/path.

## Milestone 1: Gateway Preview Endpoint

Status: Proposed

Failing tests first:

- `GET /v1/threads/:threadId/images/preview` serves an image under the thread project's canonical cwd.
- The endpoint serves an image under the configured uploads directory.
- The endpoint serves an image under the Codex generated-images directory.
- The endpoint rejects paths outside the thread/project root and gateway media roots.
- The endpoint rejects missing files, directories, oversized files, and non-image files.

Implementation:

- Add a route under the thread API:
  - `GET /v1/threads/{threadId}/images/preview?path=...`
- Resolve the request context from `threadId`.
- Determine allowed roots:
  - the selected thread's project cwd when available
  - configured `uploads.dir`
  - Codex generated-images root, defaulting to `$CODEX_HOME/generated_images` or `~/.codex/generated_images`
- Canonicalize the requested path and each existing allowed root.
- Allow only when the canonical requested path starts with one of the canonical allowed roots.
- Reject symlink escapes through the canonical path check.
- Reject directories and non-files.
- Enforce a conservative preview size limit.
- Return image bytes with `Content-Type`, `Content-Length` when known, and `Cache-Control: private`.
- Return `404` or `403` for denied paths without exposing extra filesystem detail.

Exit conditions:

- Backend route tests cover allowed and denied paths.
- The route is represented in generated OpenAPI.
- The endpoint remains local/VPN-scoped and is documented as an image preview service, not a filesystem server.

## Milestone 2: Frontend Image Asset Normalization

Status: Proposed

Failing tests first:

- Raw `image_generation_call` response items normalize to an image asset with a `data:image/png;base64,...` source.
- App-server `imageGeneration` thread items normalize to an image asset with `src`, `prompt`, `status`, and optional `path`.
- `imageView` thread items normalize to a path-backed image asset.
- Tool output content containing `input_image`/`inputImage` normalizes to a browser-loadable source.

Implementation:

- Add a small image asset normalization helper for timeline payloads.
- Use a shared asset shape:

```ts
type TimelineImageAsset = {
  id: string;
  src?: string;
  path?: string;
  title?: string;
  prompt?: string;
  status?: string;
  source: "image_generation" | "tool_output" | "image_view";
};
```

- Keep source extraction defensive and schema-shaped.
- Do not add broad media parsing beyond the observed image payloads.

Exit conditions:

- Existing image renderers consume the normalized asset shape.
- Unknown or malformed image payloads do not crash the timeline.

## Milestone 3: Frontend Preview URL Rendering

Status: Proposed

Failing tests first:

- Browser-loadable image sources render directly.
- Local image paths render through the thread-scoped preview URL.
- Denied or failed previews show an unavailable-image placeholder.
- The lightbox uses the same resolved preview source as the thumbnail.

Implementation:

- Add a helper that resolves an asset to a renderable URL:

```ts
function imageRenderSrc(asset: TimelineImageAsset, threadId: string): string | null {
  if (asset.src && isBrowserLoadableImageSrc(asset.src)) {
    return asset.src;
  }

  if (asset.path) {
    return `/v1/threads/${encodeURIComponent(threadId)}/images/preview?path=${encodeURIComponent(asset.path)}`;
  }

  return null;
}
```

- Update `ImageActivityBlock`, `ImageThumbnail`, or their caller to use the helper.
- Show a compact placeholder on image load failure.
- Keep the path visible or copyable so the user understands what was referenced.

Exit conditions:

- Local-path images are displayable when allowed by the gateway.
- Non-showable images have a stable, readable fallback.

## Milestone 4: Verification And Review

Status: Proposed

Implementation:

- Regenerate OpenAPI after the gateway route is added.
- Regenerate frontend API types after OpenAPI changes.
- Run backend formatting and tests.
- Run focused frontend unit/component tests.
- Run a manual or browser-based smoke test against:
  - a generated base64 image result
  - a generated image saved under `~/.codex/generated_images`
  - an `imageView` path under the active project cwd
  - a denied path outside allowed roots
- Perform an independent review pass before completion.

Exit conditions:

- `cargo fmt --check`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Review finds no major security or rendering issues.
