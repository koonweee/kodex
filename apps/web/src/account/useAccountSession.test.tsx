import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { getAccount, logout } from "../api/client";
import { useAccountSession } from "./useAccountSession";

vi.mock("../api/client", () => ({ getAccount: vi.fn(), logout: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("reads authoritative account state after logout, including a provider that needs no OpenAI auth", async () => {
  const loggedIn = { account: { accountType: "chatgpt", email: "user@example.com", rawPayload: {} }, requiresOpenaiAuth: true, rawPayload: {} };
  const loggedOut = { account: null, requiresOpenaiAuth: false, rawPayload: { requiresOpenaiAuth: false } };
  vi.mocked(getAccount).mockResolvedValueOnce(loggedIn).mockResolvedValue(loggedOut);
  vi.mocked(logout).mockResolvedValue();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useAccountSession({ onError: vi.fn() }), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.account).toEqual(loggedIn));
  act(() => result.current.handleLogout());
  await waitFor(() => expect(result.current.account).toEqual(loggedOut));
  expect(getAccount).toHaveBeenCalledTimes(2);
  expect(logout).toHaveBeenCalledTimes(1);
});
