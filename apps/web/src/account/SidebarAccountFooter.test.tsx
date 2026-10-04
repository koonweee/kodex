import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AccountResponse } from "../api/client";
import { SidebarAccountMenu } from "./SidebarAccountFooter";

describe("SidebarAccountMenu", () => {
  it("offers native sign-in from the logged-out account menu", async () => {
    renderMenu({ account: { account: null, requiresOpenaiAuth: true, rawPayload: {} } });
    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByRole("menuitem", { name: /sign in with chatgpt/i })).toBeInTheDocument();
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
    <MantineProvider>
      <SidebarAccountMenu
        account={account}
        onLogout={vi.fn()}
        onOpenPreferences={vi.fn()}
        onSelectAutomations={vi.fn()}
        onShowDebugEventsChange={vi.fn()}
        showDebugEvents={false}
        usageLimitLines={null}
      />
    </MantineProvider>
    </QueryClientProvider>,
  );
}
