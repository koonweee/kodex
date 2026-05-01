import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway } from "./test/gatewayMock";

const capabilitiesResponse = {
  gateway: {
    version: "0.1.0",
    sse: true,
    approvals: true,
    gatewayAuth: false,
    trustedNetworkOnly: true,
  },
  appServer: {
    ready: true,
    experimentalApi: true,
  },
};

describe("App shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the MVP shell with gateway capabilities", async () => {
    mockGateway({
      "GET /v1/capabilities": capabilitiesResponse,
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
      "GET /v1/models": { models: [], nextCursor: null, rawPayload: {} },
    });

    render(<App />);

    expect(screen.getByRole("banner", { name: /kodex/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /thread/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /approvals/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /status/i }));
    expect(await screen.findByText(/gateway 0\.1\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/app-server ready/i)).toBeInTheDocument();
    expect(screen.getByText(/trusted network/i)).toBeInTheDocument();
  });

  it("keeps gateway status visible when optional app-server-backed calls fail", async () => {
    mockGateway({
      "GET /v1/capabilities": {
        ...capabilitiesResponse,
        appServer: { ready: false, experimentalApi: true },
      },
      "GET /v1/projects": { projects: [] },
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /status/i }));
    expect(await screen.findByText(/gateway 0\.1\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/app-server offline/i)).toBeInTheDocument();
  });
});
