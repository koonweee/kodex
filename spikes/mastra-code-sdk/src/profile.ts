import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SpikeProfile {
  readonly root: string;
  readonly homeDir: string;
  readonly appDataDir: string;
  readonly authPath: string;
  readonly settingsPath: string;
  readonly databasePath: string;
}

const markerName = ".kodex-mastra-spike.json";
const marker = { kind: "kodex-mastra-code-sdk-spike", version: 1 };
let activeRoot: string | undefined;

/** Separate from native Mastra, Codex and Pi profiles; never imports their data. */
export function resolveProfile(root = process.env.KODEX_MASTRA_PROFILE ?? join(homedir(), ".kodex", "mastra-spike")): SpikeProfile {
  const absoluteRoot = resolve(root);
  if (absoluteRoot === resolve(homedir())) throw new Error("A spike profile cannot be the real home directory.");
  const appDataDir = join(absoluteRoot, "data");
  return Object.freeze({
    root: absoluteRoot,
    homeDir: join(absoluteRoot, "home"),
    appDataDir,
    authPath: join(appDataDir, "auth.json"),
    settingsPath: join(appDataDir, "settings.json"),
    databasePath: join(appDataDir, "mastra.db"),
  });
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Spike profile paths must not be symbolic links.");
}

function validateProfile(profile: SpikeProfile): void {
  const expected = resolveProfile(profile.root);
  for (const key of Object.keys(expected) as (keyof SpikeProfile)[]) {
    if (profile[key] !== expected[key]) throw new Error("Spike profile paths must stay inside their dedicated root.");
  }
}

/** Call once at process startup, before constructing any SDK runtime/auth defaults.
 * Native provider credential modules are singletons: profiles cannot be switched.
 */
export function activateProfile(profile: SpikeProfile): SpikeProfile {
  validateProfile(profile);
  if (activeRoot !== undefined) {
    if (activeRoot !== profile.root) throw new Error("CodeSDK supports one profile per process in this spike.");
    assertProfileActive(profile);
    return profile;
  }
  rejectSymlink(profile.root);
  if (existsSync(profile.root) && readdirSync(profile.root).length > 0) {
    const markerPath = join(profile.root, markerName);
    rejectSymlink(markerPath);
    let existing: unknown;
    try { existing = JSON.parse(readFileSync(markerPath, "utf8")); } catch {}
    if (JSON.stringify(existing) !== JSON.stringify(marker)) {
      throw new Error("Refusing a nonempty directory that is not an initialized Kodex Mastra spike profile.");
    }
  }
  for (const directory of [profile.root, profile.homeDir, profile.appDataDir]) {
    rejectSymlink(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  for (const path of [profile.authPath, profile.settingsPath, profile.databasePath]) rejectSymlink(path);
  const markerPath = join(profile.root, markerName);
  writeFileSync(markerPath, JSON.stringify(marker) + "\n", { mode: 0o600 });
  process.env.MASTRA_APP_DATA_DIR = profile.appDataDir;
  process.env.MASTRA_DB_PATH = profile.databasePath;
  activeRoot = profile.root;
  return profile;
}

export function assertProfileActive(profile: SpikeProfile): void {
  validateProfile(profile);
  if (activeRoot !== profile.root || process.env.MASTRA_APP_DATA_DIR !== profile.appDataDir || process.env.MASTRA_DB_PATH !== profile.databasePath) {
    throw new Error("Activate the dedicated spike profile before creating the CodeSDK runtime.");
  }
}
