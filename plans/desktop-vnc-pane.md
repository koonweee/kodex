# Desktop VNC Pane

## Status

Active. Scope agreed with the user on 2026-10-24. The durable plan is recorded and the execution goal is active. The authentication/relay foundation and private service configuration are implemented and independently reviewed. The fixed-target WebSocket endpoint and generated capability/error contract are also implemented. Viewer/pane integration and authenticated Mac proofs remain pending; evidence is recorded below. Execute M1–M5 below, recording evidence as each exit is met. Deployment and push are outside this plan.

## Objective

Add a single dockable Desktop pane per browser workspace to control the Mac running the Kodex gateway. Reuse Pal's patched embedded noVNC viewer, with automatic gateway-owned authentication and usable touch input. Keep desktop access within Kodex's trusted local/VPN deployment boundary.

## Confirmed product decisions

- Connect only to the gateway's Mac, using a fixed loopback Screen Sharing target. No remote host picker or arbitrary TCP destination.
- Put Desktop immediately below Terminal in the sidebar. Hide the entry until a dedicated VNC password is configured on the gateway. A configured password does not imply Screen Sharing is reachable; connection failures appear inside the pane and do not prevent Kodex startup.
- Allow at most one Desktop pane per workspace. Opening it again focuses the existing pane. Disable duplication and normalize duplicate restored records. Other browser tabs/devices may independently connect; no global controller lock or takeover protocol.
- Connect automatically when the pane opens or is restored. Preserve the connection while its dock tab is hidden. Close the connection when the pane closes. Closing, retrying or disconnecting leaves the Mac and its applications running.
- Retry transient connection failures automatically with a capped backoff and expose Reconnect. Authentication and configuration errors stop automatic retries. Closing the pane cancels connections, timers and in-flight attempts; stale callbacks cannot revive it. Do not overlap retries or native connections within one pane.
- Always allow control after authentication. Omit View only and fullscreen controls, including those in the embedded viewer. Use normal workspace docking and resizing.
- Scale to fit by default and preserve the Mac's display resolution. Retain Pal's local touch zoom/pan. Do not request remote resolution changes on pane resize.
- Follow Pal's input behavior: trackpad mode is enabled by default, users may toggle direct touch, and physical mouse behavior remains normal. Apply actual touch behavior at any pane width, including hybrid devices.
- Expose a touch keyboard toggle, explicit Paste button, Reconnect and the required touch settings. Reuse Pal's keyboard show/hide focus-race handling. Keep these controls reachable when the software keyboard reduces the viewport.
- Send Escape to the Mac while the viewer has focus. Suspend Kodex application shortcuts while interacting with the viewer. Clicking elsewhere returns input to Kodex. Browser/OS-reserved shortcuts retain their native limitations; no keyboard trap or promise to capture all shortcuts.
- Paste client clipboard text into the Mac only on an explicit button action, matching Pal. Surface denied/unavailable/empty clipboard and disconnected errors without sending a paste shortcut. No automatic clipboard synchronization or copy-from-Mac feature.
- Configure a dedicated Screen Sharing VNC password once on the gateway, with automatic login and no browser login form. The gateway performs VNC authentication; the password never enters browser responses, JavaScript, iframe messages, URLs, browser storage or transcript state.
- Bundle Pal's embedded viewer locally in an iframe at a pinned upstream version plus the pinned touch patch. Preserve the mounted iframe and input state across hide/show, pane resizing and relocation where the docking lifecycle permits it; verify the actual docking behavior rather than assuming it.

## Existing implementation and provenance

Kodex has a typed pane registry/store and docking lifecycle in `apps/web/src/workspace`, a terminal pane in `apps/web/src/panes/terminal`, and axum WebSocket examples in `apps/gateway/src/routes/terminals.rs`. The installed macOS service has an explicit environment allowlist; a shell export alone is not service configuration.

The adjacent Pal checkout was inspected at `/Users/jtkw/Projects/pal`:

- `backend/desktop/novnc-trackpad.README.md` documents noVNC 1.6.0 and PR #2065 revision `f634c6b37e944d82fc377259e1b5e22672a65877`.
- `backend/desktop/novnc-trackpad.patch` ports relative movement, discrete taps, two-finger right-click/scroll, selection dragging, local pinch zoom/pan, edge pan, iOS native-zoom suppression and a short-swipe accidental-click fix. Mouse behavior stays native.
- `backend/desktop/novnc-trackpad.tests.patch` carries upstream gesture cases and the short-swipe regression.
- `frontend/src/desktop/Desktop.tsx` enables `trackpad_mode=true` and wraps the viewer with keyboard, paste and fullscreen controls. Reuse the relevant behavior, removing fullscreen and Pal-specific drawer/presentation code.
- `frontend/test/desktop.spec.ts` and the playground tests contain keyboard-focus, mounted-viewer, clipboard and cached-module regressions.

Vendor the required MPL-licensed noVNC source and derivative touch/test patches with exact source revisions/checksums, copyright/license notices and modified-source availability. Port the useful behavioral regressions and reimplement the small Pal wrapper behaviors in Kodex; do not wholesale import Pal-specific application components or test harnesses. The resulting build must not depend on a sibling checkout or the running Pal service. Pal's recorded passing tests and mobile emulation are reference evidence, not Kodex validation or actual iPhone approval.

## Technical design

### Transport and authentication

The connection path is `browser iframe -- secure WebSocket --> gateway -- TCP loopback --> macOS Screen Sharing (:5900)`.

Implement a bounded RFB authentication adapter in the Rust gateway. To the trusted browser-side viewer, it presents the no-password RFB security mode inside the existing HTTPS/WSS transport. To the Mac, it negotiates the supported protocol/security method and performs dedicated VNC-password challenge/response. Complete upstream authentication first, synthesize the downstream RFB 3.8 version/security-type-None/SecurityResult exchange expected by stock noVNC, then splice the streams at ClientInit. Verify this exact boundary, including buffered bytes and the shared-session flag. Propagate useful classified failures. Relay initialization and subsequent traffic unchanged after the handshake; do not decode/re-encode framebuffer data or build a full VNC server/client.

Scope supported upstream authentication to the dedicated VNC password path. Account-password/Apple Diffie–Hellman authentication, generic security negotiation frameworks and silent fallback to unauthenticated upstream access are excluded. Handle Apple's advertised protocol version using verified native behavior and the maintained noVNC reference. Use an established cryptographic implementation for standard VNC challenge/response; do not implement DES primitives by hand. Verify macOS's exact legacy password encoding/length semantics, document the effective eight-byte limit, and reject unsupported or overlong configured values with an actionable Desktop configuration error instead of silently truncating. An absent or empty password means unconfigured.

Each browser socket owns an independent upstream socket. Use bounded handshake sizes/timeouts, correct partial/coalesced-read handling, cancellation and transport backpressure. Clean up both directions on close/error. Connect only to the fixed loopback target, validate WebSocket origin at the gateway boundary, and preserve local/VPN-only hosting assumptions. A server-held password does not add user authentication to Kodex; trusted gateway access still permits desktop control.

### Configuration, API and packaging

Add a gateway-only `KODEX_VNC_PASSWORD` configuration value and support it through the installed service controller's private configuration/environment allowlist. Use a redacted, non-serializable secret field: the existing Config derives Debug and Serialize, so naive addition would expose the password. Keep the secret out of configuration diagnostics, public DTOs, debug output and generated examples. Preserve/enforce the private service configuration file's 0600 permissions. Regression-test secret redaction and removal from inherited Codex/terminal child environments. Do not put the secret in the launchd plist or commit local configuration.

Expose only the minimal nonsecret configured/capability information needed to hide/show the sidebar action and handle restored panes. Define public DTOs in Rust, export OpenAPI, and regenerate frontend API types. Reuse an appropriate existing capability response if it avoids a new endpoint without conflating unrelated state. Do not store desktop sessions or passwords in SQLite, app-server config or workspace layout. No new SSE event stream or shared lifecycle database is needed for per-viewer connections.

Pin the noVNC source and patch reproducibly, include MPL-2.0 notices/source provenance, and fail builds when the patch no longer applies. Review any required source integration modifications as a small explicit Kodex patch. Bundle assets with the normal frontend/service packaging, without a CDN, separate websockify process, runtime downloads or external web server. Account for nested module imports and existing PWA cache rules so shell updates load a consistent viewer; WebSocket traffic, connection errors and credential material must never enter offline caches. Preserve viewer mounts across unrelated shell/theme updates.

### Browser ownership and clipboard

Add a named Desktop pane domain and singleton open/restore policy rather than expanding `App.tsx`. Reuse workspace focus, placement, title and pane boundary helpers. A restored Desktop pane without configured support must show a concise unavailable state and leave other panes usable; the sidebar stays hidden.

Treat the bundled iframe as trusted application code, distinct from the generated-app sandbox. Keep its host bridge small and scoped to its current frame. Validate any message source/origin, avoid arbitrary evaluation or command APIs, and preserve synchronous user gestures for software-keyboard activation and clipboard permission requests. Disable hidden viewer input without disconnecting the socket; hidden iframe initialization must not steal composer focus. Prevent duplicate reconnect owners between noVNC and the React host. Classify transient versus authentication/configuration failures through a stable typed error/close contract, with bounded nonsecret detail; do not make retry decisions by matching prose.

Use Kodex's shared pane/input/visual-viewport owners for host layout and touch ergonomics. Retain narrowly scoped vendor gesture behavior inside the iframe; document any required responsive-audit exception rather than adding a second application device taxonomy. Read theme guidance/token contracts before styling; use Mantine and semantic tokens for Kodex-owned controls.

Verify macOS clipboard negotiation and Unicode behavior against real Screen Sharing. Pal's Linux Shift+Insert paste sequence must not be copied unchanged. Use the smallest correct macOS paste path with explicit clipboard-write-before-paste ordering and correct focus/modifier cleanup. If native VNC clipboard support cannot carry required text, investigate a bounded gateway-owned macOS clipboard write as a focused fallback, document the concrete gap and test it; do not silently corrupt Unicode or add a general shell-execution feature.

## Milestones

### M1 — Authentication and macOS compatibility proof

- [x] Inspect current gateway config/service/WebSocket seams and Pal source/provenance; record a narrow dependency and protocol decision.
- [x] Begin the authentication adapter with failing tests for successful handshake and classified failure. Cover partial/coalesced reads, Apple's version negotiation, unsupported security, wrong password, timeout and disconnect using a bounded fake upstream.
- [x] Implement gateway-side dedicated-password authentication and post-auth byte relay without leaking the password to the viewer.
- [ ] Prove the browser-side security transcript with the real pinned noVNC client through the M2 WebSocket integration.
- [ ] Run a real Screen Sharing authentication/session proof on the gateway Mac using privately configured credentials. Verify existing desktop access, two independent shared connections, unchanged display resolution and native behavior on disconnect.
- [ ] Probe macOS text clipboard/paste, including multiline Unicode and emoji, to choose the smallest correct implementation before finalizing that integration.

Exit: authentication/relay tests pass and real-Mac behavior is evidenced, or the exact missing local setup is recorded as pending. Missing credentials/Screen Sharing setup must not trigger privileged system changes or solicit a password in chat. Continue independent mock-backed implementation while local proof is pending; do not claim overall completion without real-Mac proof or an explicit user-approved scope change.

### M2 — Gateway feature, service configuration and viewer bundle

- [x] Add the fixed-target WebSocket route, origin checks, configured status and bounded lifecycle/error handling.
- [x] Support private service configuration; keep secret handling redacted and scoped to the gateway. Cover service allowlist, packaging and relevant environment inheritance behavior.
- [ ] Vendor/bundle the pinned viewer and Pal patch with licenses/provenance and a reproducible preparation/build path. Bring over relevant gesture regression tests.
- [x] Generate OpenAPI/frontend types and wire the capability read without exposing credentials.

Exit: backend/service tests pass; the bundled viewer loads through Kodex and authenticates through the gateway without any browser password. Independent clients own separate sockets; failed authentication/configuration does not enter a retry loop or stop Kodex startup.

### M3 — Singleton Desktop pane and controls

- [ ] Start with focused failing domain tests for singleton opening/restoration, configured-only navigation, close/hidden lifecycle, retry cancellation and stale attempts.
- [ ] Add Desktop beneath Terminal, singleton pane registration/codec restoration and focus-existing behavior; disable duplication.
- [ ] Embed the patched viewer, maintain its connection through hiding and resizing, and implement exactly one reconnect owner with classified errors and capped backoff.
- [ ] Add keyboard, paste, reconnect and touch settings. Remove stock fullscreen, view-only, remote-host, remote-resolution, clipboard/copy-back, connect/disconnect, power and unrelated settings controls from the exposed viewer; retain only the agreed actions and one reconnect owner. Underlying remote clipboard protocol handling may remain for compatibility without exposing copy-back UI or automatic client clipboard writes.
- [ ] Implement focused input handling, hidden-viewer focus protection, Escape routing, software keyboard toggling and verified macOS paste behavior.

Exit: focused component/domain tests pass; closing releases sockets/timers, reopening creates a fresh connection, and other panes retain their drafts/focus. No Desktop singleton or input ownership decision depends on another tab's React state.

### M4 — Browser, native and touch acceptance

- [ ] Use Playwright's bundled Chromium and agent-browser where available. Search for an installed agent-browser skill/tool before using it; record an unavailable tool rather than launching installed Google Chrome.
- [ ] Verify sidebar visibility, repeated opening, restored duplicate normalization, normal docking/resizing, hidden connection continuity, closing cleanup and reconnect recovery.
- [ ] Verify two same-user browser clients connect independently; closing or retrying one does not terminate the other. Neither viewer may request exclusive native desktop access.
- [ ] Exercise desktop fine pointer, narrow fine pointer, narrow touch, wide touch with a compact pane, and hybrid input. Verify relative movement without clicks, taps, right-click, scroll, selection drag, pinch/pan, short-swipe regression and settings toggle.
- [ ] Verify keyboard show/hide focus races, Escape delivery, click-out focus, no hidden focus stealing, visual-viewport changes, adjacent panes and console cleanliness. Ensure agreed controls remain reachable without hover.
- [ ] Verify explicit paste success and permission/empty/disconnected failure behavior; complete the real-Mac authentication and Unicode paste proofs if previously pending.
- [ ] Record actual iPhone Safari/PWA keyboard, gesture and paste evidence separately from emulation. If a physical device is unavailable, document those checks as pending manual follow-up and describe the limits of automated evidence; do not invent a separate approval requirement.

Exit: automated and live browser/native proofs meet the agreed scope, with no unresolved demonstrated correctness failures. Physical-device checks are accurately recorded as passed or pending manual follow-up, never inferred from mobile emulation. Remaining limitations and native/browser constraints are documented.

### M5 — Review, documentation and completion

- [ ] Independently review each coherent implementation chunk with a bounded read-only review subagent. Use GPT-5.6 Sol with high reasoning, falling back to GPT-6.1 Sol high if unavailable; the main agent applies fixes and verifies them. If no review agent is available, document the required self-review.
- [ ] Run `cargo fmt`, relevant backend tests and `./tools/trim-backend.sh`; frontend domain/browser tests, `npm run generate:api`, `npm run build` and `./tools/trim-frontend.sh`; service changes require `python3 -m unittest discover -s tools/tests -p 'test_kodex_service*.py'`. Run broader suites where integration risk or failures justify them. Shared theme changes require the repository's additional rendered contrast gates.
- [ ] Update README/setup/deployment documentation and this plan/index with final behavior, private credential configuration, Screen Sharing setup, vendor maintenance instructions and validation evidence. Update AGENTS.md only if contributor workflow changes.
- [ ] Review generated-contract changes and unused-code/dependency findings. Document unrelated pre-existing failures without absorbing unrelated cleanup.
- [ ] Commit coherent tested changes, preserving unrelated workspace content. No push, service update/restart or deployment is authorized by this plan.

Exit: all applicable exit criteria pass, generated artifacts and docs agree with the implementation, independent review has no unresolved major findings, and the execution goal can honestly be marked complete. Deployment remains a separate explicit request.

## Scope boundaries

No multiple target hosts, saved-host UI, global control lease/takeover, view-only mode, fullscreen, remote display resizing, automatic clipboard sync/copy-back, screen recording, audio, file transfer, new agent-facing desktop tools, generic VNC server, Keychain integration or macOS account-password authentication. Do not automatically enable macOS Screen Sharing, alter firewall/Tailscale routes, restart the installed service, disturb Pal's running desktop, or change the Mac's applications/files to set up the feature. Use disposable fixtures for proofs and clean up task-owned artifacts.

## References

- [Plans index](index.md), [gateway terminal](gateway-terminal.md), [responsive UI contract](responsive-ui-contract.md), [macOS service](../docs/macos-service.md), [deployment assumptions](../docs/deployment.md), and [contributor rules](../AGENTS.md).
- [Apple Screen Sharing setup](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac).
- [RFB 3.8 specification](https://www.rfc-editor.org/rfc/rfc6143.html), [noVNC 1.6.0 authentication implementation](https://github.com/novnc/noVNC/blob/v1.6.0/core/rfb.js), and [trackpad PR #2065](https://github.com/novnc/noVNC/pull/2065).

## Execution evidence

2026-10-24: Product decisions and Pal provenance inspected and recorded. The execution goal is active and uses this file as the durable scope/progress record. Initial read-only discovery confirms Screen Sharing is listening on `127.0.0.1:5900` and advertises `RFB 003.889`. Neither the current gateway process environment nor the installed service configuration contains `KODEX_VNC_PASSWORD`; only presence booleans were printed. A second read-only negotiation using RFB 3.8 reports security types `[30, 33, 36, 35]`; dedicated VNC-password authentication (type 2) is not currently offered. The selected feature therefore also needs macOS's VNC-password access option enabled during one-time user setup. Both probes disconnected before selecting authentication. No VNC login, screen capture, system setting change or service restart was performed. Authenticated Mac/clipboard proofs remain pending that setup and private gateway credential configuration. Implementation tests and device proofs have not run.

Plan review: a bounded independent read-only review confirmed the handshake-only proxy is feasible and identified explicit splice-boundary, secret serialization/inheritance and vendor-provenance requirements; these are incorporated above. Review also requires strict legacy-password validation and removal of stock noVNC controls outside the agreed surface, including copy-back and competing connection controls; both are now explicit above. Final independent review reports no unresolved major findings; the plan is ready to drive execution.

### Authentication/configuration foundation (2026-10-24)

- The success-path regression first failed before implementation; the new explicit service-setting test and isolated Codex-child secret-inheritance test also failed before their fixes. The Rust adapter now completes upstream type-2 authentication using RustCrypto `des` 0.9.0 with zeroized key storage, synthesizes the downstream RFB3.8/None exchange, canonicalizes nonzero shared flags to 1, and splices at ClientInit. Zero security offers remain transient; nonempty offers without type 2 are configuration failures. Fixed-size reads, one handshake deadline, transport backpressure and owned-stream cancellation/EOF handling are covered.
- Tests exercise deterministic DES challenge bytes verified independently with OpenSSL, Apple version negotiation, staged fragmentation, coalesced downstream input/upstream result+init, native failures without private reason forwarding, exclusive-viewer rejection, timeout and task-abort cleanup.
- `KODEX_VNC_PASSWORD` is loaded through redacted, non-serializable config and discarded after validated key derivation. Empty is unconfigured; unsupported/overlong nonempty values retain a controlled configuration error without retaining their text. A real isolated-process config test covers environment loading. Both actual Codex and terminal child-environment proofs now assert the VNC setting is absent.
- The service controller accepts the explicit private setting, rejects group/world-accessible secret-bearing config and NUL-containing environment values, excludes configured/ambient credentials from login and operation-worker plists, and creates private config-rewrite files before writing. Existing signing-identity updates preserve their atomic replacement and private final mode.
- Validation: `cargo test -p kodex-gateway --lib` passes 772 tests (four intentionally ignored child fixtures are invoked by parent tests); all 70 service tests pass; `cargo fmt`, `git diff --check` and `./tools/trim-backend.sh` pass. Independent protocol and config/service review findings were fixed, regression-tested and re-reviewed with clear dispositions. No public HTTP DTO changed in this foundation, so OpenAPI/frontend generation is deferred to route/capability integration.
- Official noVNC `v1.6.0` resolves to source commit `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820` (annotated tag object `95aaf779f7e16c5c427c68ac56976c6ae1c080f5`); bundle preparation/checksums remain M2 work.
- The user requested that all human intervention be deferred until the end. Continue route/viewer/pane/mock-backed work autonomously; leave the known macOS VNC-password/private credential setup and real-Mac proofs pending. No system setup, installed service mutation, deployment or push was performed.

### WebSocket transport and public capability (2026-10-24)

- The capability regression first failed because `gateway.desktop.enabled` was absent. It now reports only the macOS/configured boolean through the existing generated capability response; absent/empty disables it, and invalid nonempty configuration remains visible for a controlled connection error. The generated `DesktopFailure` unit enum is the public close-reason type.
- `GET /v1/desktop/ws` requires exactly one valid HTTP(S) Origin matching the retained browser-facing Host, including normalized ports, and rejects missing/null/duplicate origins, alternate hosts, userinfo and path-bearing origins. Reverse-proxy retained Host is exercised without trusting forwarded-header overrides. The production connector accepts no target input and connects only to `127.0.0.1:5900`; unsupported platforms and unconfigured/invalid settings fail before native connection.
- The framing success regression first failed before its implementation. The bridge now owns bounded binary-message, write-queue, duplex and copy buffers; separate inbound/outbound pumps prevent bidirectional pressure deadlocks, and canceling the connection drops every pump/connector/stream. Upstream auth remains gateway-only. Close 4400 carries permanent configuration/auth/protocol failures; 4500 carries transient connection/timeouts, with only the serialized generated enum as its reason.
- A new final-frame-before-close regression exposed buffered output loss on native EOF. The corrected path drains the final queued bytes with a bounded deadline before its close frame. Real local WebSocket tests also cover 150KB output, simultaneous 100KB input/150KB output with a blocked native reader, coalesced client handshake/data, wrong-password non-admission, text rejection, close during stalled authentication and two independent connections where closing one leaves the other usable.
- `npm run generate:api` regenerated the committed TypeScript contract; five capability fixtures were updated. Full `cargo test -p kodex-gateway --quiet` passes 780 library tests plus four integration tests, with four isolated-child fixtures and 34 existing opt-in native proofs intentionally ignored by the default runner. The 36 frontend gateway-boundary tests, frontend build/typecheck and frontend/backend trim checks pass. Independent endpoint/framing review and a follow-up review of the demonstrated EOF fix report no remaining actionable findings. The existing Vite large-chunk advisory remains nonfatal and unrelated.
- This proves the gateway transport with bounded fake RFB upstreams and actual local WebSockets; the bundled pinned noVNC client, browser pane/touch workflows and real Mac login/paste are still pending. No installed service or network configuration changed.
