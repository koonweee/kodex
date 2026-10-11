import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { GatewayClient } from "../api/client";
import { GatewayClientProvider } from "../api/GatewayClientContext";
import { useAccountSession } from "./useAccountSession";

afterEach(() => vi.resetAllMocks());

it("reads authoritative account state after logout, including a provider that needs no OpenAI auth", async () => {
  const loggedIn = { account: { accountType: "chatgpt", email: "user@example.com", rawPayload: {} }, requiresOpenaiAuth: true, rawPayload: {} };
  const loggedOut = { account: null, requiresOpenaiAuth: false, rawPayload: { requiresOpenaiAuth: false } };
  const getAccount = vi.fn().mockResolvedValueOnce(loggedIn).mockResolvedValue(loggedOut);
  const logout = vi.fn().mockResolvedValue(undefined);
  const api = { getAccount, logout } as unknown as GatewayClient;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useAccountSession({ onError: vi.fn() }), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><GatewayClientProvider client={api}>{children}</GatewayClientProvider></QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.account).toEqual(loggedIn));
  act(() => result.current.handleLogout());
  await waitFor(() => expect(result.current.account).toEqual(loggedOut));
  expect(getAccount).toHaveBeenCalledTimes(2);
  expect(logout).toHaveBeenCalledTimes(1);
});
