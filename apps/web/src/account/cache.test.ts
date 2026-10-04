import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { AccountResponse, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAccountEvent, refreshAccountQueries } from "./cache";

const loggedOut: AccountResponse = { account: null, requiresOpenaiAuth: true, rawPayload: {} };
const loggedIn: AccountResponse = {
  account: { accountType: "chatgpt", email: "user@example.com", planType: "plus", rawPayload: {} },
  requiresOpenaiAuth: true,
  rawPayload: {},
};
const event = (kind: string, payload: unknown): EventEnvelope => ({
  id: "event-1", seq: 1, kind, codexMethod: null, projectId: null, threadId: null,
  payload, receivedAt: "2026-10-04T00:00:00Z",
});

function observeAccount(read: (signal: AbortSignal) => Promise<AccountResponse>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const observer = new QueryObserver(client, { queryKey: queryKeys.account, queryFn: ({ signal }) => read(signal) });
  const unsubscribe = observer.subscribe(() => {});
  return { client, unsubscribe };
}

describe("native account cache", () => {
  it("converges two clients after sign-in, sign-out, and a missed event followed by reconnect", async () => {
    let nativeAccount = loggedOut;
    const read = vi.fn(async () => nativeAccount);
    const a = observeAccount(read);
    const b = observeAccount(read);
    await refreshAccountQueries(a.client);
    await refreshAccountQueries(b.client);
    expect(a.client.getQueryData(queryKeys.account)).toEqual(loggedOut);
    expect(b.client.getQueryData(queryKeys.account)).toEqual(loggedOut);

    nativeAccount = loggedIn;
    for (const { client } of [a, b]) {
      applyAccountEvent(client, event("account.updated", { authMode: "chatgpt" }));
      await refreshAccountQueries(client);
      expect(client.getQueryData(queryKeys.account)).toEqual(loggedIn);
    }
    nativeAccount = loggedOut;
    applyAccountEvent(a.client, event("account.updated", { authMode: null }));
    await refreshAccountQueries(a.client);
    expect(a.client.getQueryData(queryKeys.account)).toEqual(loggedOut);
    expect(b.client.getQueryData(queryKeys.account)).toEqual(loggedIn);
    await refreshAccountQueries(b.client);
    expect(b.client.getQueryData(queryKeys.account)).toEqual(loggedOut);
    a.unsubscribe();
    b.unsubscribe();
  });

  it("coalesces ordinary refills without cancelling an in-flight read", async () => {
    let finish!: (value: AccountResponse) => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<AccountResponse>((resolve) => { finish = resolve; }));
    const { client, unsubscribe } = observeAccount(read);
    const first = refreshAccountQueries(client);
    const second = refreshAccountQueries(client);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].aborted).toBe(false);
    finish(loggedIn);
    await Promise.all([first, second]);
    expect(client.getQueryData(queryKeys.account)).toEqual(loggedIn);
    unsubscribe();
  });

  it("recovers a missed account change with a read started after subscription", async () => {
    let finishOld!: (value: AccountResponse) => void;
    const read = vi.fn<(signal: AbortSignal) => Promise<AccountResponse>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(loggedIn);
    const { client, unsubscribe } = observeAccount(read);
    // The first read captured signed-out state before the stream subscribed.
    // No account event can correct it; recovery must perform a new native read.
    const refills = [
      refreshAccountQueries(client, { cancelInFlight: true }),
      refreshAccountQueries(client, { cancelInFlight: true }),
    ];
    finishOld(loggedOut);
    await Promise.all(refills);

    expect(client.getQueryData(queryKeys.account)).toEqual(loggedIn);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    unsubscribe();
  });

  it("cancels stale account reads at an account change and rejects their later result", async () => {
    let finishOld!: (value: AccountResponse) => void;
    const read = vi.fn<(signal: AbortSignal) => Promise<AccountResponse>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(loggedOut);
    const { client, unsubscribe } = observeAccount(read);
    applyAccountEvent(client, event("account.updated", { authMode: null }));
    expect(read.mock.calls[0][0].aborted).toBe(true);
    await refreshAccountQueries(client);
    finishOld(loggedIn);
    await Promise.resolve();
    expect(client.getQueryData(queryKeys.account)).toEqual(loggedOut);
    unsubscribe();
  });

  it("keeps completion by native ID before the start response and ignores malformed completion", () => {
    const client = new QueryClient();
    applyAccountEvent(client, event("account.login_completed", { loginId: "attempt-a", success: false, error: "expired" }));
    applyAccountEvent(client, event("account.login_completed", { loginId: "attempt-b", success: true }));
    applyAccountEvent(client, event("account.login_completed", { loginId: "attempt-a", success: "true" }));
    expect(client.getQueryData(queryKeys.accountLoginCompletion("attempt-a"))).toEqual({ loginId: "attempt-a", success: false, error: "expired" });
    expect(client.getQueryData(queryKeys.accountLoginCompletion("attempt-b"))).toEqual({ loginId: "attempt-b", success: true, error: null });
    expect(client.getQueryData(queryKeys.account)).toBeUndefined();
  });
});
