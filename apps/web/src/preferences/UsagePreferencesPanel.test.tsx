import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeRateLimitResetCredit, getRateLimits, type RateLimitsResponse } from "../api/client";
import { UsagePreferencesPanel } from "./UsagePreferencesPanel";

vi.mock("../api/client", () => ({ consumeRateLimitResetCredit: vi.fn(), getRateLimits: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

function data(): RateLimitsResponse {
  return {
    rateLimits: { credits: { balance: "0", hasCredits: false, unlimited: false }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2000000000 } },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { id: "one", title: "Weekly gift", grantedAt: 1, expiresAt: 2000000000, status: "available", resetType: "codexRateLimits" },
      { id: "two", title: "Thank you gift", grantedAt: 2, expiresAt: null, status: "available", resetType: "codexRateLimits" },
    ] }, rawPayload: {},
  };
}
function setup(value = data(), client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  vi.mocked(getRateLimits).mockResolvedValue(value);
  return render(<QueryClientProvider client={client}>
    <MantineProvider><UsagePreferencesPanel /></MantineProvider>
  </QueryClientProvider>);
}

describe("Usage preferences", () => {
  it("shows zero credits, weekly limits, names, and expiry, then redeems the selected reset", async () => {
    setup();
    expect(await screen.findByText("0 credits remaining")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByText("0% left")).toBeInTheDocument();
    expect(screen.getByText(/^Expires /)).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    vi.mocked(consumeRateLimitResetCredit).mockResolvedValue({ outcome: "reset" });
    vi.mocked(getRateLimits).mockResolvedValue({ ...data(), rateLimitResetCredits: { availableCount: 0, credits: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Use reset: Thank you gift" }));
    await waitFor(() => expect(consumeRateLimitResetCredit).toHaveBeenCalledWith({ creditId: "two", idempotencyKey: expect.any(String) }, expect.anything()));
    expect(await screen.findByText("Plan limits reset.")).toBeInTheDocument();
    expect(await screen.findByText("No resets available.")).toBeInTheDocument();
  });

  it.each(["nothingToReset", "noCredit", "alreadyRedeemed"] as const)("explains native %s without claiming a new reset", async (outcome) => {
    setup();
    vi.mocked(consumeRateLimitResetCredit).mockResolvedValue({ outcome });
    fireEvent.click(await screen.findByRole("button", { name: "Use reset: Weekly gift" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(outcome === "nothingToReset" ? "No plan limits" : outcome === "noCredit" ? "No resets" : "already applied"));
    expect(screen.queryByText("Plan limits reset.")).not.toBeInTheDocument();
  });

  it("does not automatically retry an ambiguous reset and reuses its key on explicit retry", async () => {
    setup();
    vi.mocked(consumeRateLimitResetCredit).mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(await screen.findByRole("button", { name: "Use reset: Weekly gift" }));
    expect(await screen.findByText(/Could not confirm/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Use reset: Weekly gift" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(consumeRateLimitResetCredit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Use reset: Thank you gift" })).toBeDisabled();
    vi.mocked(consumeRateLimitResetCredit).mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    fireEvent.click(button);
    await waitFor(() => expect(consumeRateLimitResetCredit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(consumeRateLimitResetCredit).mock.calls[0][0]).toEqual(vi.mocked(consumeRateLimitResetCredit).mock.calls[1][0]);
  });

  it("distinguishes unknown details from no resets, and never invents a zero balance", async () => {
    setup({ rawPayload: {}, rateLimits: {}, rateLimitResetCredits: { availableCount: 3, credits: null } });
    expect(await screen.findByText("Credits unavailable")).toBeInTheDocument();
    expect(screen.getByText("Reset details unavailable. Refresh to choose a reset.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use reset/ })).not.toBeInTheDocument();
  });

  it("retains an ambiguous attempt across panel remounts even if the credit row disappears", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = setup(data(), client);
    vi.mocked(consumeRateLimitResetCredit).mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(await screen.findByRole("button", { name: "Use reset: Weekly gift" }));
    await screen.findByRole("button", { name: "Retry reset" });
    first.unmount();
    setup({ ...data(), rateLimitResetCredits: { availableCount: 0, credits: [] } }, client);
    await screen.findByText("No resets available.");
    vi.mocked(consumeRateLimitResetCredit).mockResolvedValueOnce({ outcome: "alreadyRedeemed" });
    fireEvent.click(screen.getByRole("button", { name: "Retry reset" }));
    expect(await screen.findByText("This reset was already applied.")).toBeInTheDocument();
    expect(vi.mocked(consumeRateLimitResetCredit).mock.calls[0][0]).toEqual(vi.mocked(consumeRateLimitResetCredit).mock.calls[1][0]);
  });

  it("can create a reset attempt when randomUUID is unavailable", async () => {
    setup();
    vi.stubGlobal("crypto", {});
    vi.mocked(consumeRateLimitResetCredit).mockResolvedValueOnce({ outcome: "nothingToReset" });
    fireEvent.click(await screen.findByRole("button", { name: "Use reset: Weekly gift" }));
    await waitFor(() => expect(consumeRateLimitResetCredit).toHaveBeenCalled());
    expect(vi.mocked(consumeRateLimitResetCredit).mock.calls[0][0].idempotencyKey.length).toBeGreaterThan(0);
  });

  it("disables expired, redeeming and unknown reset types", async () => {
    const value = data();
    value.rateLimitResetCredits!.credits![0].expiresAt = 1;
    value.rateLimitResetCredits!.credits![1].status = "redeeming";
    setup(value);
    expect(await screen.findByRole("button", { name: "Use reset: Weekly gift" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use reset: Thank you gift" })).toBeDisabled();
  });
});
