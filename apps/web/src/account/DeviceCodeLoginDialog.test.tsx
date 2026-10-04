import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../api/client";
import { mockGateway } from "../test/gatewayMock";
import { applyAccountEvent } from "./cache";
import { SidebarAccountMenu } from "./SidebarAccountFooter";
import { useAccountSession } from "./useAccountSession";

const login = { loginType: "chatgptDeviceCode", loginId: "attempt-a", userCode: "CODE-1234", verificationUrl: "https://auth.example.test/device" };
const loggedOut = { account: null, requiresOpenaiAuth: true, rawPayload: {} };
afterEach(() => vi.restoreAllMocks());

function Harness() {
  const { account, handleLogout } = useAccountSession({ onError: vi.fn() });
  return <SidebarAccountMenu account={account} onLogout={handleLogout} onOpenPreferences={vi.fn()}
    onSelectAutomations={vi.fn()} onShowDebugEventsChange={vi.fn()} showDebugEvents={false} />;
}

function setup(routes: Parameters<typeof mockGateway>[0] = {}) {
  const gateway = mockGateway({
    "GET /v1/account": loggedOut,
    "POST /v1/account/login": login,
    "POST /v1/account/login/attempt-a/cancel": { rawPayload: { status: "canceled" } },
    ...routes,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MantineProvider env="test"><Harness /></MantineProvider></QueryClientProvider>);
  return { client, gateway };
}

async function start() {
  fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /sign in with chatgpt/i, hidden: true }));
}

function complete(client: QueryClient, loginId: string, success: boolean, error: string | null = null) {
  const event: EventEnvelope = {
    id: loginId, seq: 1, kind: "account.login_completed", codexMethod: "account/login/completed",
    projectId: null, threadId: null, payload: { loginId, success, error }, receivedAt: "2026-10-04T00:00:00Z",
  };
  act(() => applyAccountEvent(client, event));
}

describe("native device-code sign-in", () => {
  it("shows the native code and link, sends no browser-login options, and cancels the matching attempt", async () => {
    const { gateway } = setup();
    await start();
    expect(await screen.findByLabelText("One-time code")).toHaveValue("CODE-1234");
    expect(screen.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", login.verificationUrl);
    expect(await gateway.callsFor("POST", "/v1/account/login")[0].text()).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(gateway.callsFor("POST", "/v1/account/login/attempt-a/cancel")).toHaveLength(1);
  });

  it("handles failure delivered before the start response, then retries with a new native ID", async () => {
    let finish!: (value: typeof login) => void;
    let attempts = 0;
    const { client } = setup({ "POST /v1/account/login": () => ++attempts === 1
      ? new Promise<typeof login>((resolve) => { finish = resolve; })
      : { ...login, loginId: "attempt-b", userCode: "NEXT-CODE" } });
    await start();
    await screen.findByText("Requesting a sign-in code…");
    complete(client, "attempt-a", false, "device auth timed out after 15 minutes");
    await act(async () => finish(login));
    expect(await screen.findByRole("alert")).toHaveTextContent("device auth timed out after 15 minutes");
    expect(screen.queryByLabelText("One-time code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("One-time code")).toHaveValue("NEXT-CODE");
    complete(client, "attempt-a", true);
    expect(screen.getByLabelText("One-time code")).toHaveValue("NEXT-CODE");
    complete(client, "attempt-b", true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps start and cancellation errors visible and allows retry", async () => {
    let attempts = 0;
    const { gateway } = setup({
      "POST /v1/account/login": () => ++attempts === 1
        ? new Response(JSON.stringify({ message: "Device-code login unavailable", code: "bad_gateway", retryable: false }), { status: 502 })
        : login,
      "POST /v1/account/login/attempt-a/cancel": () => new Response(JSON.stringify({ message: "Unable to cancel", code: "bad_gateway", retryable: true }), { status: 502 }),
    });
    await start();
    expect(await screen.findByRole("alert")).toHaveTextContent("Device-code login unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByLabelText("One-time code");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to cancel");
    expect(screen.getByLabelText("One-time code")).toHaveValue(login.userCode);
    expect(gateway.callsFor("POST", "/v1/account/login")).toHaveLength(2);
  });

  it("closes when a native account refill observes sign-in from another client", async () => {
    let account: unknown = loggedOut;
    const { client } = setup({ "GET /v1/account": () => account });
    await start();
    await screen.findByLabelText("One-time code");
    account = { ...loggedOut, account: { accountType: "chatgpt", email: "user@example.com", rawPayload: {} } };
    act(() => applyAccountEvent(client, {
      id: "change", seq: 2, kind: "account.updated", payload: { authMode: "chatgpt" }, receivedAt: "2026-10-04T00:00:00Z",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("U")).toBeInTheDocument();
  });
});
