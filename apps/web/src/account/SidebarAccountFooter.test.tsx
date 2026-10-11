import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AccountResponse } from "../api/client";
import { createGatewayClient } from "../api/client";
import { GatewayClientProvider } from "../api/GatewayClientContext";
import { SidebarAccountMenu } from "./SidebarAccountFooter";

describe("SidebarAccountMenu", () => {
  it("opens Usage preferences from the limits and positive-credit block", async () => {
    const onOpenPreferences = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><GatewayClientProvider client={createGatewayClient()}><MantineProvider env="test"><SidebarAccountMenu account={null}
      onLogout={vi.fn()} onOpenPreferences={onOpenPreferences} onSelectAutomations={vi.fn()}
      onShowDebugEventsChange={vi.fn()} showDebugEvents={false}
      usageLimitLines={{ primary: "7d 0% left", credits: "25 credits remaining" }}
    /></MantineProvider></GatewayClientProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
    expect(await screen.findByText("25 credits remaining")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Usage details" }));
    expect(onOpenPreferences).toHaveBeenCalledWith("usage");
  });
  it("offers independent debug and command-output toggles in that order", async () => {
    const onDebug = vi.fn();
    const onOutputs = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><GatewayClientProvider client={createGatewayClient()}><MantineProvider><SidebarAccountMenu account={null} onLogout={vi.fn()} onOpenPreferences={vi.fn()} onSelectAutomations={vi.fn()} onShowDebugEventsChange={onDebug} onShowCommandOutputsChange={onOutputs} showDebugEvents={false} showCommandOutputs={false} /></MantineProvider></GatewayClientProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    const debug = await screen.findByRole("menuitemcheckbox", { name: "Show debug events" });
    const outputs = await screen.findByRole("menuitemcheckbox", { name: "Show command outputs", hidden: true });
    expect(debug).toHaveAttribute("aria-checked", "false");
    expect(outputs).toHaveAttribute("aria-checked", "false");
    expect(debug.compareDocumentPosition(outputs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(outputs);
    expect(onOutputs).toHaveBeenCalledWith(true);
    expect(onDebug).not.toHaveBeenCalled();
  });

  it("offers native sign-in from the logged-out account menu", async () => {
    renderMenu({ account: { account: null, requiresOpenaiAuth: true, rawPayload: {} } });
    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByRole("menuitem", { name: /sign in with chatgpt/i })).toBeInTheDocument();
  });

  it("opens executor-scoped account preferences in federation mode", async () => {
    const onOpenPreferences = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><GatewayClientProvider client={createGatewayClient()}><MantineProvider>
      <SidebarAccountMenu account={null} manageAccountInPreferences onLogout={vi.fn()} onOpenPreferences={onOpenPreferences}
        onSelectAutomations={vi.fn()} onShowDebugEventsChange={vi.fn()} showDebugEvents={false} />
    </MantineProvider></GatewayClientProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Accounts" }));
    expect(onOpenPreferences).toHaveBeenCalledWith("account");
    expect(screen.queryByRole("menuitem", { name: /sign in with chatgpt/i })).not.toBeInTheDocument();
  });

  it("renders the first email letter as the account trigger avatar when logged in", () => {
    renderMenu({
      account: {
        requiresOpenaiAuth: false,
        account: {
          accountType: "chatgpt",
          email: "dev@example.com",
          planType: "pro",
          rawPayload: {},
        },
        rawPayload: {},
      },
    });

    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
    expect(screen.getByText("D")).toHaveClass("kodex-account-menu-avatar");
  });

  it("keeps the user icon trigger when logged out", () => {
    const { container } = renderMenu({ account: null });

    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
    expect(container.querySelector(".kodex-account-menu-avatar")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-circle-user-round")).toBeInTheDocument();
  });
});

function renderMenu({ account }: { account: AccountResponse | null }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
    <GatewayClientProvider client={createGatewayClient()}><MantineProvider>
      <SidebarAccountMenu
        account={account}
        onLogout={vi.fn()}
        onOpenPreferences={vi.fn()}
        onSelectAutomations={vi.fn()}
        onShowDebugEventsChange={vi.fn()}
        showDebugEvents={false}
        usageLimitLines={null}
      />
    </MantineProvider></GatewayClientProvider>
    </QueryClientProvider>,
  );
}
