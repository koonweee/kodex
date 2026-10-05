# Runtime and integration shortcut audit — 2026-10-05

Scope: current deployment, gateway/native boundaries, frontend contract/update behavior and Control plugin wiring. This is a focused source audit, not a claim to exhaustively revalidate every retained feature.

## Fixed in the pinned-runtime change

- **Desktop extraction and incomplete packaging.** The service copied only the desktop distribution’s inner executable bundle, losing the external Code Mode helper. Replace it with the complete official architecture-specific package matching the schema pin, verified against a checked-in SHA256 digest. Desktop installation is no longer a prerequisite.
- **Startup health did not establish tool readiness.** Version/initialization/HTTP checks can all pass with a missing helper. Validate the packaged helper before switching the live service; run a disposable real-native execution proof for this change.
- **Controller update bootstrap.** The installed updater runs the previous release’s packaging code. When changing that controller, invoke the tested checkout updater directly. This is documented rather than adding a second self-updater subsystem.

## Remaining findings

| Priority | Evidence | Issue and simpler direction |
| --- | --- | --- |
| High | `apps/web/src/api/GatewayInstanceBoundary.tsx`, `apps/web/src/pwa/PwaLifecycle.tsx`, `apps/gateway/src/routes/capabilities.rs:56` | Instance identity protects storage separation but is not an API/build compatibility fence. An old PWA can continue using removed API fields/routes after backend deployment until Update is accepted. We observed this during the section removal. Add a small explicit compatibility/build signal and a draft-preserving update-required state before incompatible commands; do not auto-reload unsent work. |
| Medium | `apps/web/src/pwa/registerServiceWorker.ts:55` | Custom controller-change reload state/listener duplicates the installed `vite-plugin-pwa` update callback’s controlling/reload behavior. Delegate reload to the library, or use one explicit `onNeedReload` callback if needed. |
| Medium | `apps/web/package.json:17`; existing `apps/gateway/examples/export_openapi.rs` | Default API generation reads whatever happens to run on localhost:8787, which may be the old installed release. Make the checkout’s Rust OpenAPI exporter the default source. |
| Medium | `apps/gateway/src/routes/file_preview.rs:96`; `apps/gateway/src/app_server_api/client.rs:90` | File preview reads a complete transcript only to obtain cwd/id. Use the existing metadata-only `thread_read_summary` method. |
| Medium | `apps/gateway/src/turn_lifecycle.rs:37` | Stop reads and reprojects complete history to find the active turn. Use native metadata and a bounded descending turn-header page while retaining authoritative gateway routing. |
| Medium | `apps/gateway/src/app_server.rs:373`; `apps/gateway/src/routes/turns.rs:173`; `apps/gateway/src/app_server_api/client.rs:171,698` | Native RPC errors lose code/data structure early, then callers classify formatted prose to resume/retry or infer empty history. Preserve a typed internal RPC error and centralize narrow pinned-version classification. Native does not provide a dedicated structured not-found discriminant, so some exact message recognition remains justified; generic error-code matching is insufficient. |
| Low, development only | `apps/web/src/sw.ts:99`; API client base URL configuration | Browser API requests can use a separate configured base while service-worker badge reads always use the frontend origin. Production deliberately forces same-origin builds, so installed hosting is unaffected. Clarify or constrain development support before adding another routing mechanism. |

## Patterns that remain justified

- Dedicated native home, environment scrubbing and managed-configuration checks protect desktop state; no direct desktop database/rollout/auth imports were found.
- The gateway’s native snapshot/SSE projection, authoritative read receipts, retained automation/terminal supervision and generated-app surfaces implement explicit product requirements or browser transport needs.
- The managed Control binding supplies the running gateway executable and local URL. It avoids discovering an unrelated global service and is not a desktop dependency.
- Self-contained release copies support deliberate rollback without a mutable shared runtime cache. Retaining old releases is documented; automatic garbage collection would need to account for native installed-plugin references.

Remaining findings are recommendations, not implemented fixes in this packaging change.
