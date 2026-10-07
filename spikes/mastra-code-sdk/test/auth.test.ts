import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, getOAuthProvider } from "@mastra/code-sdk/auth/index";
import { authStatus, loginChatGpt, requireChatGptAuth } from "../src/auth.js";
import { runLoginCli } from "../src/login.js";
import { activateProfile, assertProfileActive, resolveProfile } from "../src/profile.js";

function temporaryProfile(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kodex-mastra-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return resolveProfile(root);
}

test("a fresh profile requires its own ChatGPT OAuth credentials", (t) => {
  const profile = temporaryProfile(t);
  const auth = new AuthStorage(profile.authPath);
  assert.deepEqual(authStatus(profile, auth), {
    provider: "openai-codex", configured: false, expiresAt: null, needsRefresh: false,
  });
  assert.throws(() => requireChatGptAuth(profile, auth), /dedicated profile.*login/i);
  assert.equal(auth.list().length, 0);
});

test("SDK fixture credentials stay inside their profile and status never exposes secrets", (t) => {
  const first = temporaryProfile(t);
  const second = temporaryProfile(t);
  const auth = new AuthStorage(first.authPath);
  auth.set("openai-codex", { type: "oauth", access: "fixture-access-secret", refresh: "fixture-refresh-secret", expires: 1 });
  assert.equal(requireChatGptAuth(first, auth), auth);
  const status = authStatus(first, auth);
  assert.equal(status.configured, true);
  assert.equal(status.needsRefresh, true);
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(authStatus(second).configured, false);
  assert.equal(new AuthStorage(first.authPath).isLoggedIn("openai-codex"), true);
});

test("login delegates provider and selected mode to native AuthStorage", async (t) => {
  const profile = temporaryProfile(t);
  const auth = new AuthStorage(profile.authPath);
  const calls: unknown[][] = [];
  const nativeLogin = auth.login.bind(auth);
  auth.login = async (...args) => {
    calls.push(args);
    auth.set("openai-codex", { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 });
    return { type: "oauth-account", id: "fixture", label: "fixture", addedAt: new Date().toISOString(), active: true, access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 };
  };
  t.after(() => { auth.login = nativeLogin; });
  const callbacks = { onAuth() {}, async onPrompt() { return ""; }, authMode: "device" };
  const result = await loginChatGpt(profile, callbacks, auth);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "openai-codex");
  assert.equal(calls[0]?.[1], callbacks);
  assert.equal(result.configured, true);
  assert.equal(JSON.stringify(result).includes("fixture-access"), false);
});

test("an existing unrelated directory is refused rather than adopted as a profile", (t) => {
  const profile = temporaryProfile(t);
  writeFileSync(join(profile.root, "existing-user-data"), "leave this alone");
  assert.throws(() => activateProfile(profile), /nonempty/i);
  assert.equal(readFileSync(join(profile.root, "existing-user-data"), "utf8"), "leave this alone");
});

test("activation isolates native auth, refuses profile switching, and redacts CLI failures", async (t) => {
  const profile = temporaryProfile(t);
  const other = temporaryProfile(t);
  const oldHome = process.env.HOME;
  const appDir = process.env.MASTRA_APP_DATA_DIR;
  const dbPath = process.env.MASTRA_DB_PATH;
  t.after(() => {
    if (appDir === undefined) delete process.env.MASTRA_APP_DATA_DIR; else process.env.MASTRA_APP_DATA_DIR = appDir;
    if (dbPath === undefined) delete process.env.MASTRA_DB_PATH; else process.env.MASTRA_DB_PATH = dbPath;
  });
  activateProfile(profile);
  assertProfileActive(profile);
  assert.equal(process.env.HOME, oldHome);
  assert.equal(process.env.MASTRA_APP_DATA_DIR, profile.appDataDir);
  assert.equal(process.env.MASTRA_DB_PATH, profile.databasePath);
  const native = new AuthStorage();
  native.set("openai-codex", { type: "oauth", access: "fixture-native", refresh: "fixture-native-refresh", expires: 1 });
  assert.equal(JSON.parse(readFileSync(profile.authPath, "utf8"))["openai-codex"].access, "fixture-native");
  assert.throws(() => activateProfile(other), /one profile per process/i);
  const provider = getOAuthProvider("openai-codex");
  assert.ok(provider);
  const errors: string[] = [];
  t.mock.method(provider, "login", async () => { throw new Error("fixture-provider-access fixture-provider-refresh"); });
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  assert.equal(await runLoginCli(["login", "--profile", profile.root, "--mode", "device"]), 1);
  assert.match(errors.join("\n"), /retry the native login command/i);
  assert.equal(errors.join("\n").includes("fixture-provider-"), false);
});


