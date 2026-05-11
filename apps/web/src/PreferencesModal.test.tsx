import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import { PreferencesModal } from "./PreferencesModal";

const apiMocks = vi.hoisted(() => ({
  getKodexControlPluginStatus: vi.fn(),
  installKodexControlPlugin: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  getKodexControlPluginStatus: apiMocks.getKodexControlPluginStatus,
  installKodexControlPlugin: apiMocks.installKodexControlPlugin,
}));

function renderPreferences(initialSection: "appearance" | "plugins" = "plugins") {
  const queryClient = createKodexQueryClient();
  queryClient.setDefaultOptions({
    queries: {
      retry: false,
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MantineProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MantineProvider>
    );
  }

  function Harness() {
    const [section, setSection] = useState<"appearance" | "plugins">(initialSection);
    return (
      <PreferencesModal
        activeSection={section}
        colorSchemeId="oled-black"
        onClose={vi.fn()}
        onColorSchemeChange={vi.fn()}
        onSectionChange={setSection}
        opened
      />
    );
  }

  return {
    queryClient,
    ...render(<Harness />, { wrapper: Wrapper }),
  };
}

describe("PreferencesModal plugins tab", () => {
  beforeEach(() => {
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.installKodexControlPlugin.mockReset();
  });

  it("shows plugin status and install action", async () => {
    apiMocks.getKodexControlPluginStatus.mockResolvedValue({
      appServerReady: true,
      appsNeedingAuth: [],
      authPolicy: null,
      marketplaceAdded: false,
      marketplacePath: "/repo/.agents/plugins/marketplace.json",
      mcpServers: ["kodex-control"],
      plugin: null,
      pluginName: "kodex-control",
      setupError: null,
      skills: ["kodex-proxy-evaluation"],
      status: "notInstalled",
    });
    apiMocks.installKodexControlPlugin.mockResolvedValue({ status: {}, marketplace: null, install: null });

    const { queryClient } = renderPreferences();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findByText("Kodex Control")).toBeInTheDocument();
    expect(await screen.findByText("Available")).toBeInTheDocument();
    expect(await screen.findByText("1 skills · 1 MCP servers")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^install$/i }));

    await waitFor(() => expect(apiMocks.installKodexControlPlugin).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.kodexControlPlugin }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["skills"] });
  });

  it("shows loading and status fetch errors", async () => {
    apiMocks.getKodexControlPluginStatus.mockImplementation(() => new Promise(() => {}));

    const { unmount } = renderPreferences();

    expect(await screen.findByText("Checking plugin status")).toBeInTheDocument();
    unmount();

    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.getKodexControlPluginStatus.mockRejectedValue(new Error("status fetch failed"));
    renderPreferences();

    expect(await screen.findByText("status fetch failed")).toBeInTheDocument();
  });

  it("shows installed state without an install action", async () => {
    apiMocks.getKodexControlPluginStatus.mockResolvedValue({
      appServerReady: true,
      appsNeedingAuth: [],
      authPolicy: "onInstall",
      marketplaceAdded: true,
      marketplacePath: "/repo/.agents/plugins/marketplace.json",
      mcpServers: ["kodex-control"],
      plugin: { installed: true, enabled: true },
      pluginName: "kodex-control",
      setupError: null,
      skills: ["kodex-proxy-evaluation"],
      status: "installed",
    });

    renderPreferences();

    expect(await screen.findByRole("button", { name: /^installed$/i })).toBeDisabled();
    expect(screen.getAllByText("Installed")).toHaveLength(2);
  });

  it("surfaces app-server setup errors without enabling install", async () => {
    apiMocks.getKodexControlPluginStatus.mockResolvedValue({
      appServerReady: false,
      appsNeedingAuth: [],
      authPolicy: null,
      marketplaceAdded: false,
      marketplacePath: null,
      mcpServers: [],
      plugin: null,
      pluginName: "kodex-control",
      setupError: "Codex app-server is unavailable",
      skills: [],
      status: "appServerUnavailable",
    });

    renderPreferences();

    expect(await screen.findByText("App-server unavailable")).toBeInTheDocument();
    expect(screen.getByText("Codex app-server is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^install$/i })).toBeDisabled();
  });

  it("keeps appearance and plugins tab navigation separate", async () => {
    apiMocks.getKodexControlPluginStatus.mockResolvedValue({
      appServerReady: true,
      appsNeedingAuth: [],
      authPolicy: null,
      marketplaceAdded: false,
      marketplacePath: null,
      mcpServers: [],
      plugin: null,
      pluginName: "kodex-control",
      setupError: null,
      skills: [],
      status: "notInstalled",
    });

    renderPreferences("appearance");

    expect(screen.getByRole("radio", { name: /oled black/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(await screen.findByText("Kodex Control")).toBeInTheDocument();
  });
});
