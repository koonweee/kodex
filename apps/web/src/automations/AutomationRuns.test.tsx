import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import type { AutomationRun } from "../api/client";
import { mockGateway } from "../test/gatewayMock";
import { AutomationRuns } from "./AutomationRuns";
import { applyAutomationRunEvent, refreshAutomationRuns } from "./runsCache";

afterEach(() => vi.restoreAllMocks());

it("shows native admission uncertainty and converges from run markers and reconnect without resending", async () => {
  const run: AutomationRun = { id: "run", automationId: "automation", targetThreadId: "chat", phase: "queued", nativeQueueId: "native-row", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
  let rows = [run];
  const gateway = mockGateway({ "GET /v1/automations/automation/runs": () => ({ runs: rows }) });
  const clients = [createKodexQueryClient(), createKodexQueryClient()];
  const views = clients.map((client) => render(<QueryClientProvider client={client}><MantineProvider env="test"><AutomationRuns automationId="automation" /></MantineProvider></QueryClientProvider>));
  await waitFor(() => expect(screen.getAllByText("Queued")).toHaveLength(2));
  rows = [{ ...run, phase: "uncertain", error: "Native admission acknowledgement was lost" }];
  for (const client of clients) applyAutomationRunEvent(client, { id: "1", seq: 1, kind: "automation.run_updated", threadId: null, payload: { automationId: "automation" }, receivedAt: "2026-10-05T00:00:00Z" });
  await waitFor(() => expect(screen.getAllByText("Delivery uncertain")).toHaveLength(2));
  expect(screen.getAllByText(/acknowledgement was lost/)).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /retry|resend/i })).not.toBeInTheDocument();
  rows = [{ ...run, phase: "dispatched", turnId: "native-turn" }];
  await Promise.all(clients.map((client) => refreshAutomationRuns(client)));
  await waitFor(() => expect(screen.getAllByText("Dispatched")).toHaveLength(2));
  expect(gateway.calls.every((request) => request.method === "GET")).toBe(true);
  for (const view of views) view.unmount();
});
