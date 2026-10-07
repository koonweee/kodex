import { AuthStorage } from "@mastra/code-sdk/auth/index";
import type { OAuthLoginCallbacks } from "@mastra/code-sdk/auth/types";
import type { SpikeProfile } from "./profile.js";

export const CHATGPT_PROVIDER = "openai-codex";

export interface ChatGptAuthStatus {
  provider: typeof CHATGPT_PROVIDER;
  configured: boolean;
  expiresAt: string | null;
  needsRefresh: boolean;
}

/** Explicit path keeps CLI/status helpers out of all stock credential stores. */
export function openProfileAuth(profile: SpikeProfile): AuthStorage {
  return new AuthStorage(profile.authPath);
}

/** Stored configuration status, not a network validation of account entitlement. */
export function authStatus(profile: SpikeProfile, storage = openProfileAuth(profile)): ChatGptAuthStatus {
  storage.reload();
  const credential = storage.get(CHATGPT_PROVIDER);
  const configured = credential?.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0 && typeof credential.refresh === "string" && credential.refresh.length > 0;
  const expiry = configured && credential?.type === "oauth" && Number.isFinite(credential.expires) ? credential.expires : undefined;
  const validDate = expiry !== undefined && Math.abs(expiry) <= 8.64e15;
  return {
    provider: CHATGPT_PROVIDER,
    configured,
    expiresAt: validDate ? new Date(expiry).toISOString() : null,
    needsRefresh: configured && (!validDate || expiry <= Date.now()),
  };
}

/** Expired credentials are allowed: native SDK owns refresh on the next request. */
export function requireChatGptAuth(profile: SpikeProfile, storage = openProfileAuth(profile)): AuthStorage {
  if (!authStatus(profile, storage).configured) {
    throw new Error("The dedicated profile needs ChatGPT OAuth credentials; run npm run login -- login.");
  }
  return storage;
}

export async function loginChatGpt(profile: SpikeProfile, callbacks: OAuthLoginCallbacks, storage = openProfileAuth(profile)): Promise<ChatGptAuthStatus> {
  await storage.login(CHATGPT_PROVIDER, callbacks);
  return authStatus(profile, storage);
}

/** Provider failures can contain request/token details; never print raw errors. */
export function safeAuthError(_error: unknown): string {
  return "ChatGPT login failed. Retry the native login command.";
}
