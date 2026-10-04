import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { mockGateway } from "../test/gatewayMock";
import { applyAccountEvent } from "./cache";
import { useDeviceCodeLogin } from "./useDeviceCodeLogin";

const loggedOut = { account: null, requiresOpenaiAuth: true, rawPayload: {} };
const code = (loginId: string) => ({ loginId, loginType: "chatgptDeviceCode", userCode: `code-${loginId}`, verificationUrl: "https://auth.example.test/device" });
afterEach(() => vi.restoreAllMocks());

function clientHook() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const hook = renderHook(() => useDeviceCodeLogin(loggedOut), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...hook, client };
}

it("handles success before the login-start response without reopening the completed attempt", async () => {
  let finish!: (value: ReturnType<typeof code>) => void;
  mockGateway({ "POST /v1/account/login": () => new Promise((resolve) => { finish = resolve; }) });
  const { result, client } = clientHook();
  act(() => result.current.start());
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => applyAccountEvent(client, {
    id: "completed", seq: 1, kind: "account.login_completed", receivedAt: "2026-10-04T00:00:00Z",
    payload: { loginId: "attempt-a", success: true, error: null },
  }));
  await act(async () => finish(code("attempt-a")));
  await waitFor(() => expect(result.current.opened).toBe(false));
  expect(result.current.login).toBeNull();
});

it("uses each tab's native ID so stale cancellation cannot target a newer attempt", async () => {
  let activeId = "";
  let next = 0;
  const gateway = mockGateway({
    "POST /v1/account/login": () => { activeId = `attempt-${++next}`; return code(activeId); },
    "POST /v1/account/login/attempt-1/cancel": () => ({ rawPayload: { status: activeId === "attempt-1" ? "canceled" : "notFound" } }),
  });
  const a = clientHook();
  const b = clientHook();
  act(() => a.result.current.start());
  await waitFor(() => expect(a.result.current.login?.loginId).toBe("attempt-1"));
  act(() => b.result.current.start());
  await waitFor(() => expect(b.result.current.login?.loginId).toBe("attempt-2"));
  act(() => a.result.current.close());
  await waitFor(() => expect(a.result.current.opened).toBe(false));
  expect(gateway.callsFor("POST", "/v1/account/login/attempt-1/cancel")).toHaveLength(1);
  expect(gateway.callsFor("POST", "/v1/account/login/attempt-2/cancel")).toHaveLength(0);
  expect(activeId).toBe("attempt-2");
  expect(b.result.current.login?.loginId).toBe("attempt-2");
  expect(b.result.current.opened).toBe(true);
});
