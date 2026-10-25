import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDesktopViewer } from "./prepare-desktop-viewer.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "kodex-viewer-"));
  try {
    cpSync(join(web, "vendor"), join(root, "vendor"), { recursive: true });
    cpSync(join(web, "src/desktop"), join(root, "src/desktop"), { recursive: true });
    for (const file of ["vite.config.ts", "package-lock.json", "scripts/prepare-desktop-viewer.mjs"]) {
      cpSync(join(web, file), join(root, file));
    }
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("prepares the patched viewer offline and ships corresponding source", () => fixture((root) => {
  const prepared = prepareDesktopViewer(root);
  const rfb = readFileSync(join(prepared.sourceRoot, "core/rfb.js"), "utf8");
  assert.match(rfb, /trackpadMode/);
  assert.match(readFileSync(join(prepared.sourceRoot, "tests/test.rfb.js"), "utf8"), /short swipe/i);
  assert.match(readFileSync(prepared.indexPath, "utf8"), /src\/desktop\/viewer\/main.ts/);
  const sources = join(root, "public", prepared.url.replace(/index.html$/, "sources"));
  assert.deepEqual(readFileSync(join(sources, "source.tar.gz")), readFileSync(join(root, "vendor/novnc/source.tar.gz")));
  assert.equal(prepareDesktopViewer(root).url, prepared.url);
  const main = join(root, "src/desktop/viewer/main.ts");
  writeFileSync(main, readFileSync(main, "utf8") + "\n// revision change\n");
  const next = prepareDesktopViewer(root);
  assert.notEqual(next.url, prepared.url);
  assert.match(next.url, /^\/assets\/desktop-viewer\//);
  assert.deepEqual(readdirSync(join(root, "public/assets/desktop-viewer")), [next.url.split("/")[3]]);
  assert.deepEqual(readdirSync(join(root, "assets/desktop-viewer")), [next.url.split("/")[3]]);
}));

test("refuses a changed archive or patch even when prepared output exists", () => fixture((root) => {
  prepareDesktopViewer(root);
  const patch = join(root, "vendor/novnc/trackpad.patch");
  writeFileSync(patch, readFileSync(patch, "utf8") + "\n");
  assert.throws(() => prepareDesktopViewer(root), /checksum mismatch: trackpad.patch/);
}));

test("rejects edited prepared source instead of silently building unpinned code", () => fixture((root) => {
  const prepared = prepareDesktopViewer(root);
  writeFileSync(join(prepared.sourceRoot, "core/rfb.js"), "// unpinned edit\n");
  assert.throws(() => prepareDesktopViewer(root), /Prepared Desktop source changed/);
}));


test("metadata-only and corresponding-source edits receive new immutable URLs", () => fixture((root) => {
  let previous = prepareDesktopViewer(root).url;
  for (const file of ["vendor/novnc/README.md", "src/desktop/viewer/vendor.d.ts", "vendor/novnc/pins.json"]) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    const next = prepareDesktopViewer(root).url;
    assert.notEqual(next, previous, file);
    previous = next;
  }
}));
