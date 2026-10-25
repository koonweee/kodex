import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Offline and deterministic: no package registry, sibling checkout, or runtime download.
export function prepareDesktopViewer(root = defaultRoot) {
  const vendor = join(root, "vendor/novnc");
  const pins = JSON.parse(readFileSync(join(vendor, "pins.json"), "utf8"));
  const hash = createHash("sha256");
  for (const [file, expected] of Object.entries(pins.sha256)) {
    const bytes = readFileSync(join(vendor, file));
    if (digest(bytes) !== expected) throw new Error(`Desktop vendor checksum mismatch: ${file}`);
    hash.update(bytes);
  }
  hash.update(readFileSync(join(root, "src/desktop/bridge.ts")));
  hash.update(treeDigest(join(root, "src/desktop/viewer")));
  // Every source/notice byte shipped under the immutable revision must affect
  // its URL, including metadata-only edits and declaration files.
  for (const file of ["pins.json", "README.md"]) hash.update(readFileSync(join(vendor, file)));
  // Tooling/dependency changes can alter the emitted iframe too.
  for (const file of ["vite.config.ts", "package-lock.json", "scripts/prepare-desktop-viewer.mjs"]) {
    hash.update(readFileSync(join(root, file)));
  }
  const revision = hash.digest("hex").slice(0, 20);
  const sourceRoot = join(root, ".desktop-viewer-source", revision);
  mkdirSync(dirname(sourceRoot), { recursive: true });
  const stage = mkdtempSync(`${sourceRoot}-`);
  try {
    execFileSync("tar", ["-xzf", join(vendor, "source.tar.gz"), "--strip-components=1", "-C", stage]);
    for (const patch of ["trackpad.patch", "trackpad.tests.patch", "integration.patch", "integration.tests.patch"]) {
      execFileSync("git", ["apply", "--check", join(vendor, patch)], { cwd: stage, stdio: "pipe" });
      execFileSync("git", ["apply", join(vendor, patch)], { cwd: stage, stdio: "pipe" });
    }
    // The vendored browser tests use modern Chai's ESM entry.
    const assertions = join(stage, "tests/assertions.js");
    writeFileSync(assertions, readFileSync(assertions, "utf8").replace("chai/chai.js", "chai/index.js"));
    if (!existsSync(sourceRoot)) {
      try { renameSync(stage, sourceRoot); }
      catch (error) { if (!existsSync(sourceRoot)) throw error; }
    }
    if (existsSync(stage) && treeDigest(stage) !== treeDigest(sourceRoot)) {
      throw new Error(`Prepared Desktop source changed; remove ${sourceRoot} and retry`);
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
  // Retain immutable iframe entries and their corresponding source across
  // frontend swaps using the service controller's existing /assets retention.
  const relative = `assets/desktop-viewer/${revision}`;
  for (const base of [join(root, "assets/desktop-viewer"), join(root, "public/assets/desktop-viewer")]) {
    mkdirSync(base, { recursive: true });
    for (const entry of readdirSync(base)) {
      if (entry !== revision) rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
  const indexPath = join(root, relative, "index.html");
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, readFileSync(join(root, "src/desktop/viewer/index.html")));
  // Ship corresponding source and notices with the normal frontend packaging.
  const sources = join(root, "public", relative, "sources");
  mkdirSync(sources, { recursive: true });
  for (const file of ["source.tar.gz", "trackpad.patch", "trackpad.tests.patch", "integration.patch", "integration.tests.patch", "pins.json", "README.md"]) {
    cpSync(join(vendor, file), join(sources, file));
  }
  cpSync(join(sourceRoot, "docs"), join(sources, "licenses"), { recursive: true, filter: (path) => !path.endsWith(".md") || path.includes("LICENSE") });
  cpSync(join(sourceRoot, "AUTHORS"), join(sources, "AUTHORS"));
  cpSync(join(root, "src/desktop/viewer"), join(sources, "kodex-viewer"), { recursive: true });
  cpSync(join(root, "src/desktop/bridge.ts"), join(sources, "bridge.ts"));
  return { sourceRoot, indexPath, url: `/${relative}/index.html` };
}

function treeDigest(root) {
  const hash = createHash("sha256");
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const path = `${prefix}${name}`;
      const info = lstatSync(file);
      hash.update(path + "\0");
      if (info.isDirectory()) visit(file, `${path}/`);
      else if (info.isFile()) hash.update(readFileSync(file));
      else throw new Error(`Unexpected Desktop source entry: ${path}`);
    }
  }
  visit(root);
  return hash.digest("hex");
}
