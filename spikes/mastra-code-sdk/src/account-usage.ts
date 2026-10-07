import type { AuthStorage } from '@mastra/code-sdk/auth/index';
import { CHATGPT_PROVIDER } from './auth.js';
import { readAccount } from './account.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function windowFrom(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!record(value) || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)
    || typeof value.limit_window_seconds !== 'number' || !Number.isSafeInteger(value.limit_window_seconds) || value.limit_window_seconds <= 0
    || typeof value.reset_at !== 'number' || !Number.isSafeInteger(value.reset_at) || value.reset_at < 0) {
    throw new Error('Invalid ChatGPT usage response.');
  }
  return { usedPercent: value.used_percent, windowDurationMins: value.limit_window_seconds / 60, resetsAt: value.reset_at };
}

/** Same passive GET used by Codex's backend client; auth/refresh stays native.
 * https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
 * Project only the two usage windows shown by Kodex, never raw provider payloads.
 */
export async function readAccountUsage(storage: AuthStorage, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const before = readAccount(storage);
  if (!before.account) return null;
  let response: Response;
  try {
    const credential = await storage.getOAuthCredential(CHATGPT_PROVIDER, before.account.id);
    if (!credential) throw new Error('Missing credential');
    const headers = new Headers({ Authorization: `Bearer ${credential.access}`, Accept: 'application/json' });
    if (typeof credential.accountId === 'string' && credential.accountId) headers.set('ChatGPT-Account-Id', credential.accountId);
    const timeout = AbortSignal.timeout(10_000);
    response = await (options.fetch ?? fetch)('https://chatgpt.com/backend-api/wham/usage', {
      headers, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error('Provider request failed');
  } catch {
    throw new Error('Unable to read ChatGPT usage.');
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('Invalid ChatGPT usage response.'); }
  if (readAccount(storage).account?.id !== before.account.id) throw new Error('Account changed while reading usage.');
  if (!record(body) || (!('rate_limit' in body) && typeof body.plan_type !== 'string')) throw new Error('Invalid ChatGPT usage response.');
  const limits = body.rate_limit;
  if (limits !== undefined && limits !== null && !record(limits)) throw new Error('Invalid ChatGPT usage response.');
  return {
    accountId: before.account.id,
    observedAt: new Date().toISOString(),
    primary: windowFrom(limits?.primary_window),
    secondary: windowFrom(limits?.secondary_window),
  };
}
