# Bundled Desktop viewer

noVNC 1.6.0, source commit `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820`, from
https://github.com/novnc/noVNC. `source.tar.gz` is the unmodified GitHub source
archive. Exact SHA-256 pins are in `pins.json`. noVNC is MPL-2.0; individual
files and bundled dependencies retain their copyright/license notices.

`trackpad.patch` and `trackpad.tests.patch` are copied unchanged from Pal's
`backend/desktop/novnc-trackpad*.patch`. They port noVNC PR #2065 revision
`f634c6b37e944d82fc377259e1b5e22672a65877` to 1.6.0, including Pal's short-swipe
regression fix. Review both provenance and source before updating these pins.

The offline Vite preparation step verifies all pinned checksums, extracts into
an ignored content-addressed directory, and requires every patch to apply.
The browser uses the patched RFB core, with Kodex's small iframe wrapper in
`src/desktop/viewer`; upstream's application controls are not exposed.
`keyboard.ts` adapts noVNC's `app/ui.js` virtual keyboard implementation.
`integration.patch` adds a Unicode capability getter, rejects lossy legacy
clipboard writes, and emits `clipboardwritten` after standard/extended bytes
are queued so Command-V cannot overtake the extended request/provide exchange.
The patched vendor source and test patch are separate from Kodex's application
code. No build or deployment depends on the adjacent Pal checkout.

Source archives, patches, wrapper source and upstream license notices ship at
`/assets/desktop-viewer/<revision>/sources/` alongside the hashed iframe entry. This
makes the MPL-covered source available with the distributed viewer. Generated
source/build directories are ignored. Preparation always reapplies patches to a
fresh temporary tree and compares any cached source; edited cache files fail the
build and may be removed to restore the pristine patched source. Only the current
generated public revision is packaged. Deployed revisions and their source are
retained under the service controller's immutable `/assets` contract, so passive
old-shell tabs keep loading the matching iframe after upgrades/rollbacks.
The revision includes vendor bytes and iframe/bridge sources so an old shell
cannot accidentally request a newer, incompatible iframe.

Maintenance: `npm run test:desktop-vendor` runs the upstream RFB and gesture suites with the bundled Chromium
and the applied test patches; also run Kodex's viewer/pane browser suites and a
production build. Do not launch installed Google Chrome from the gateway.
Native macOS authentication/clipboard and physical iPhone acceptance evidence
are tracked separately in `plans/desktop-vnc-pane.md`.
