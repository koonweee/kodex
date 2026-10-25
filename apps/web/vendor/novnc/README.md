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
Patch subprocesses treat extraction as an independent tree, including when the
build runs inside another Git worktree; preparation tests cover that context.
The browser uses the patched RFB core, with Kodex's small iframe wrapper in
`src/desktop/viewer`; upstream's application controls are not exposed.
`keyboard.ts` adapts noVNC's `app/ui.js` virtual keyboard implementation.
`cursor.patch` aligns programmatically moved touch cursors by their server-defined
click hotspot, including cursor-shape changes and visual-viewport offsets.
`apple-desktop.patch` preserves Apple's 3.889 physical-desktop protocol, reads
bounded DisplayInfo2 monitor metadata and uses native SetDisplay to change the
server framebuffer. Monitor IDs are opaque server IDs, independent of
CoreGraphics physical IDs. The gateway owns password authentication and forces
shared/enhanced initialization without the optional account/session picker.
The viewer requests only the selected framebuffer after acknowledgment and
keeps input gated through its first completed pixel update. Pal's touch patches
remain unchanged; no capture helper or physical display resize is introduced.
Protocol research was checked against the MPL-2.0 noVNC-ARD implementation at
https://github.com/peetinc/noVNC-ARD/tree/d699293635083c9e0c30c8f9480993865653772a
and native macOS 27.0.1 probes. The small Kodex patch implements only the
physical-monitor path with existing framebuffer codecs; it does not bundle
noVNC-ARD's account authentication, encryption, media, clipboard or UI layer.
Explicit Paste uses a bounded same-origin gateway write to the Mac pasteboard,
then sends Command-V after success. It does not depend on VNC clipboard
negotiation or synchronize clipboard changes automatically. Hiding, closing or
reconnecting cancels pending shortcuts; an accepted clipboard write cannot be undone.
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
