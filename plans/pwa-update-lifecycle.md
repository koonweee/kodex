# PWA Update Lifecycle Plan

## Context

- Kodex already ships an installable PWA shell through `vite-plugin-pwa`, a custom Workbox service worker, and root service-worker registration.
- The current PWA flow does not expose a waiting service-worker update to React, so users can keep running an older built frontend bundle until every controlled Kodex window closes or the installed PWA is restarted.
- The target UX follows the working reference application pattern from `/Users/example/projects/reference-project`: a shared PWA service-worker helper exposes `needRefresh` state, a root-mounted lifecycle component shows an explicit update action, and the service worker activates a waiting bundle only when asked.
- This plan is scoped to app-bundle update prompts. reference application also has an offline/degraded banner, but Kodex should not add that in this change unless the scope is deliberately expanded.

## Current State

- `apps/web/vite.config.ts` configures `VitePWA` with `strategies: "injectManifest"`, `srcDir: "src"`, `filename: "sw.ts"`, `registerType: "prompt"`, a root manifest, and conservative precache glob patterns.
- `apps/web/src/main.tsx` calls `registerKodexServiceWorker()` before rendering `<App />`.
- `apps/web/src/pwa/registerServiceWorker.ts` directly calls `navigator.serviceWorker.register("/sw.js", { scope: "/" })` and returns only registered/unsupported/insecure/failed state.
- `apps/web/src/notifications/pushSubscriptions.ts` imports `registerKodexServiceWorker()` directly when enabling Web Push, so any update-lifecycle work must keep push subscriptions on the same service-worker registration path.
- `apps/web/src/sw.ts` precaches built static assets, cleans outdated caches, handles push notifications, and handles notification clicks. It does not currently handle `SKIP_WAITING` messages or call `clients.claim()` on activation.
- `apps/web/src/sw.test.ts`, `apps/web/src/pwa/registerServiceWorker.test.ts`, and `apps/web/src/notifications/pushSubscriptions.test.ts` are the closest focused test seams.
- `apps/web/src/App.tsx` owns the root `QueryClientProvider` and `MantineProvider` boundary. A global update prompt can be mounted inside `MantineProvider` without involving gateway-owned state.
- `README.md` documents that the service worker precaches built static assets only and that API routes, SSE, OpenAPI, uploads, and file previews stay network-owned. This must remain true.
- `AGENTS.md` allows browser-local state for purely visual or per-tab UI concerns. A waiting app-bundle prompt is browser-local UI state, not gateway state.

## reference application Reference

- `/Users/example/projects/reference-project/frontend/src/lib/pwa/service-worker.ts` wraps `virtual:pwa-register`, stores `needRefresh`, exposes a listener API, and provides `getServiceWorkerRegistration()` for push subscriptions.
- `/Users/example/projects/reference-project/frontend/src/components/PwaLifecycle.tsx` subscribes to update state and renders a Mantine `Alert` with an `Update` button that invokes the update callback.
- `/Users/example/projects/reference-project/frontend/src/sw.ts` handles `{ type: "SKIP_WAITING" }` messages and calls `clients.claim()` on activation.
- `/Users/example/projects/reference-project/frontend/vite.config.ts` uses `injectRegister: false` with manual `virtual:pwa-register` registration.

## Milestones

### 1. Shared PWA Registration Helper

- Scope: `apps/web/src/pwa/registerServiceWorker.ts`, or a replacement `apps/web/src/pwa/serviceWorker.ts`, plus `apps/web/src/vite-env.d.ts`.
- Work:
  - Replace the direct `navigator.serviceWorker.register("/sw.js")` ownership with a shared helper that uses `virtual:pwa-register`.
  - Preserve a compatibility API for startup registration, for example `registerKodexServiceWorker()` or a renamed `registerPwaServiceWorker()`, so `apps/web/src/main.tsx` can keep a small call site.
  - Add `PwaUpdateState` with `needRefresh` and `updateServiceWorker`.
  - Add `getPwaUpdateState()` and `subscribeToPwaUpdates(listener)` for React UI.
  - Add `getServiceWorkerRegistration()` for Web Push subscription code, returning `navigator.serviceWorker.getRegistration()` or `navigator.serviceWorker.ready` after registration starts.
  - Keep unsupported and insecure-context behavior graceful. Registration failures should be reported through return state or an optional callback, not thrown during app startup.
  - Add the `vite-plugin-pwa/client` type reference needed for `virtual:pwa-register`.
- Exit criteria:
  - Focused Vitest coverage proves the helper registers through the PWA plugin, emits `needRefresh`, exposes an update callback, handles unsupported/insecure contexts, and returns the active registration for push.
  - No browser push code directly calls `navigator.serviceWorker.register()`.

### 2. Keep Push Subscriptions On The Shared Registration Path

- Scope: `apps/web/src/notifications/pushSubscriptions.ts` and `apps/web/src/notifications/pushSubscriptions.test.ts`.
- Work:
  - Replace the direct import of `registerKodexServiceWorker()` with the shared `getServiceWorkerRegistration()` helper.
  - Keep `enableBrowserPushNotifications()` behavior stable: unsupported browsers return `null`, missing `pushManager` returns `null`, existing subscriptions are re-upserted, and new subscriptions are created with the VAPID public key.
  - Keep `currentBrowserPushSubscription()` using the active browser registration read path, but avoid duplicating registration startup logic.
- Exit criteria:
  - Existing push subscription tests continue to cover unsupported browsers, missing push manager, subscribe/upsert, re-upsert, subscribe failure, disable, and gateway-state convergence.
  - A focused test proves enabling notifications uses the shared PWA registration helper rather than creating a second registration path.

### 3. Root Update Banner UI

- Scope: new `apps/web/src/pwa/PwaLifecycle.tsx`, optional focused CSS in a new or existing `apps/web/src/styles/pwa.css`, `apps/web/src/App.css`, and `apps/web/src/App.tsx`.
- Work:
  - Add a small root-mounted component that subscribes to PWA update state on mount and unregisters on unmount.
  - Mount it inside `MantineProvider`, near the regular app shell. It should not be owned by a thread, timeline, notification preferences, or workspace pane module.
  - Render nothing until `needRefresh` is true.
  - When `needRefresh` is true, render a nonmodal Mantine `Alert` or equivalent global banner with concise copy such as "Update available" and "Reload to use the latest Kodex app bundle."
  - Provide an explicit `Update` button that calls `updateServiceWorker`.
  - Keep the prompt browser-local and per-tab. Do not add gateway state, SSE events, or cross-tab durable state for this UI.
  - Place and style the banner so it does not cover the composer, terminal drawer, image lightbox, or mobile composer in common desktop and narrow/mobile layouts.
- Exit criteria:
  - Component tests prove the banner is hidden by default, appears when a subscribed update state sets `needRefresh: true`, and calls the update callback when `Update` is clicked.
  - Responsive CSS keeps the banner inside the viewport with safe-area-aware spacing on narrow screens.
  - `$agent-browser` validation checks the banner placement on desktop, narrow desktop, and narrow touch/mobile viewport shapes with no text overflow or incoherent overlap.

### 4. Waiting Worker Activation

- Scope: `apps/web/src/sw.ts`, `apps/web/src/sw.test.ts`, and `apps/web/vite.config.ts`.
- Work:
  - Add a `message` listener in `apps/web/src/sw.ts` that calls `self.skipWaiting()` only for `{ type: "SKIP_WAITING" }`.
  - Add an `activate` listener that calls `self.clients.claim()`.
  - Keep push notification and notification-click behavior unchanged.
  - Set `injectRegister: false` in `apps/web/vite.config.ts` if needed so manual `virtual:pwa-register` registration is the only registration path.
  - Keep `registerType: "prompt"` so updates are user-applied instead of automatically reloading active work.
- Exit criteria:
  - Service-worker tests prove `SKIP_WAITING` messages call `skipWaiting`, unrelated messages do not, and activation claims clients.
  - `cd apps/web && npm run build` emits a service worker and manifest without TypeScript or Vite PWA errors.
  - Generated precache output still excludes API/SSE/OpenAPI/upload/file-preview runtime caching.

### 5. Documentation And Validation

- Scope: `README.md`, `plans/index.md`, and focused verification notes.
- Work:
  - Update README PWA documentation to explain that long-open tabs or installed PWAs may show an update banner when a new static bundle is available.
  - Preserve the local/trusted-VPN deployment language and the static-assets-only cache boundary.
  - Keep `plans/index.md` status current when implementation starts or completes.
  - Add a short implementation note that the update prompt is browser-local UI state and intentionally not gateway-owned.
- Exit criteria:
  - `README.md` accurately describes the update prompt and does not imply public deployment safety.
  - `plans/index.md` reflects the current plan status.
  - Final verification includes focused frontend tests, `cd apps/web && npm run build`, and `$agent-browser` smoke coverage.

## Verification

- `cd apps/web && npm test -- src/pwa/registerServiceWorker.test.ts src/notifications/pushSubscriptions.test.ts src/sw.test.ts`
- `cd apps/web && npm test` before marking the implementation complete.
- `cd apps/web && npm run build` to verify PWA plugin output, manifest generation, and service-worker bundling.
- `$agent-browser` against a production-style static build served by the gateway:
  - confirm the manifest is served
  - confirm the service worker is active
  - simulate or force the update state where practical and verify the banner is visible and clickable
  - inspect desktop, narrow desktop, and narrow touch/mobile viewport shapes
  - verify console cleanliness
- Manual installed-PWA smoke when practical:
  - open an installed Kodex PWA on an old bundle
  - deploy/rebuild the static frontend
  - confirm an update prompt appears without closing all windows
  - click `Update`
  - confirm the app reloads into the new bundle without losing gateway-owned thread state

## Risks And Open Questions

- Service-worker update behavior is browser-dependent, especially for installed iOS/iPadOS PWAs. The implementation should rely on standard waiting-worker activation and include manual PWA smoke coverage rather than assuming identical timing across browsers.
- The update prompt should not auto-reload because Kodex may have active drafts, panes, terminal state, or local modal state. If future bundle/API compatibility requires a forced reload, that should be a separate gateway/frontend compatibility design.
- The banner placement must account for existing fixed layers: terminal drawer, mobile composer, image lightbox, and shell toasts. CSS should be validated visually rather than assumed from z-index alone.
- Existing `apps/web/src/pwa/registerServiceWorker.ts` tests may be renamed or replaced if the helper is renamed. Keep the public intent stable even if the file name changes.
