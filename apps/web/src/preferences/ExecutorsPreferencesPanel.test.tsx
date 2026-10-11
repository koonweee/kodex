import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { FederatedCatalogContextValue } from "../federation/FederatedCatalogContext";
import { FederatedCatalogProvider } from "../federation/FederatedCatalogContext";
import { ExecutorsPreferencesPanel } from "./ExecutorsPreferencesPanel";

it("shows independent executor status and registers a backend URL", async () => {
  const registerExecutor = vi.fn().mockResolvedValue({});
  const value: FederatedCatalogContextValue = {
    catalog: null,
    error: null,
    executors: [{
      apiVersion: "4", appServerSchemaVersion: "0.160.0", baseUrl: "https://desk.example", createdAt: 1,
      displayName: "Desk Mac", enabled: true, generation: 1, id: "desk", instanceId: "instance-desk",
      lastError: null, lastSeenAt: 1_791_753_600, status: "ready", updatedAt: 1,
    }],
    moveItem: vi.fn(),
    probeExecutor: vi.fn().mockResolvedValue({}),
    registerExecutor,
    removeExecutor: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshExecutors: vi.fn().mockResolvedValue(undefined),
    refreshing: false,
    updateExecutor: vi.fn().mockResolvedValue({}),
  };
  render(
    <MantineProvider>
      <FederatedCatalogProvider value={value}><ExecutorsPreferencesPanel /></FederatedCatalogProvider>
    </MantineProvider>,
  );

  expect(screen.getByText("Desk Mac")).toBeInTheDocument();
  expect(screen.getByText("ready")).toBeInTheDocument();
  expect(screen.getByText(/Verified instance: instance-desk/)).toBeInTheDocument();
  expect(screen.getByText(/Last successful contact:/)).not.toHaveTextContent("1970");
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Build Linux");
  await userEvent.type(screen.getByRole("textbox", { name: "Backend URL" }), "https://build.example");
  await userEvent.click(screen.getByRole("button", { name: "Add executor" }));
  expect(registerExecutor).toHaveBeenCalledWith({ baseUrl: "https://build.example", displayName: "Build Linux" });
});
