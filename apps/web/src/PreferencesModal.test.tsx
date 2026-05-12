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
  listMcpServers: vi.fn(),
  readMcpResource: vi.fn(),
  reloadMcpServers: vi.fn(),
  startMcpOAuthLogin: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  getKodexControlPluginStatus: apiMocks.getKodexControlPluginStatus,
  installKodexControlPlugin: apiMocks.installKodexControlPlugin,
  listMcpServers: apiMocks.listMcpServers,
  readMcpResource: apiMocks.readMcpResource,
  reloadMcpServers: apiMocks.reloadMcpServers,
  startMcpOAuthLogin: apiMocks.startMcpOAuthLogin,
}));

function renderPreferences(initialSection: "appearance" | "plugins" | "mcp" = "plugins") {
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
    const [section, setSection] = useState<"appearance" | "plugins" | "mcp">(initialSection);
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
    apiMocks.listMcpServers.mockReset();
    apiMocks.readMcpResource.mockReset();
    apiMocks.reloadMcpServers.mockReset();
    apiMocks.startMcpOAuthLogin.mockReset();
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

describe("PreferencesModal MCP tab", () => {
  beforeEach(() => {
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.installKodexControlPlugin.mockReset();
    apiMocks.listMcpServers.mockReset();
    apiMocks.readMcpResource.mockReset();
    apiMocks.reloadMcpServers.mockReset();
    apiMocks.startMcpOAuthLogin.mockReset();
  });

  it("shows MCP inventory and resource details", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "notLoggedIn",
          name: "docs",
          resourceTemplates: [{ name: "doc-template", title: "Doc Template", uriTemplate: "file:///docs/{id}" }],
          resources: [{ name: "readme", title: "README", uri: "file:///docs/readme.md" }],
          tools: {
            lookup: { inputSchema: { type: "object" }, name: "lookup" },
          },
        },
      ],
    });
    apiMocks.readMcpResource.mockResolvedValue({
      contents: [{ mimeType: "text/markdown", text: "# Docs", uri: "file:///docs/readme.md" }],
    });

    renderPreferences("mcp");

    expect((await screen.findAllByText("docs")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 tools · 1 resources · 1 templates")).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();
    expect(screen.getByText("Doc Template")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /README/ }));

    expect(await screen.findByText("# Docs")).toBeInTheDocument();
    expect(apiMocks.readMcpResource).toHaveBeenCalledWith("docs", "file:///docs/readme.md");
  });

  it("renders JSON-like resource content without arbitrary URI input", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "unsupported",
          name: "docs",
          resourceTemplates: [],
          resources: [{ name: "metadata", title: "Metadata", uri: "file:///docs/meta.json" }],
          tools: {},
        },
      ],
    });
    apiMocks.readMcpResource.mockResolvedValue({
      contents: [{ mimeType: "application/json", structured: { count: 2 }, uri: "file:///docs/meta.json" }],
    });

    renderPreferences("mcp");

    expect(screen.queryByRole("textbox", { name: /uri/i })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Metadata/ }));

    expect(await screen.findByText(/"structured":/)).toBeInTheDocument();
    expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    expect(apiMocks.readMcpResource).toHaveBeenCalledWith("docs", "file:///docs/meta.json");
  });

  it("shows resource loading and error states", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "unsupported",
          name: "docs",
          resourceTemplates: [],
          resources: [{ name: "readme", title: "README", uri: "file:///docs/readme.md" }],
          tools: {},
        },
      ],
    });
    apiMocks.readMcpResource.mockImplementation(() => new Promise(() => {}));
    const loadingRender = renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /README/ }));

    expect(await screen.findByText("Reading resource")).toBeInTheDocument();
    loadingRender.unmount();

    apiMocks.listMcpServers.mockReset();
    apiMocks.readMcpResource.mockReset();
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "unsupported",
          name: "docs",
          resourceTemplates: [],
          resources: [{ name: "readme", title: "README", uri: "file:///docs/readme.md" }],
          tools: {},
        },
      ],
    });
    apiMocks.readMcpResource.mockRejectedValue(new Error("resource failed"));
    renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /README/ }));

    expect(await screen.findByText("resource failed")).toBeInTheDocument();
  });

  it("summarizes binary resource contents without dumping blob payloads", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "unsupported",
          name: "media",
          resourceTemplates: [],
          resources: [{ name: "logo", title: "Logo", uri: "file:///media/logo.png" }],
          tools: {},
        },
      ],
    });
    apiMocks.readMcpResource.mockResolvedValue({
      contents: [
        {
          blob: "VGhpcy1pcy1hLWJpbmFyeS1ibG9iLXBheWxvYWQtdGhhdC1zaG91bGQtbm90LXJlbmRlcg==",
          mimeType: "image/png",
          uri: "file:///media/logo.png",
        },
      ],
    });

    renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /Logo/ }));

    expect(await screen.findByText(/Unsupported binary resource/)).toBeInTheDocument();
    expect(screen.getByText(/MIME type: image\/png/)).toBeInTheDocument();
    expect(screen.getByText(/Encoded payload length: \d+ characters/)).toBeInTheDocument();
    expect(screen.queryByText(/VGhpcy1pcy1hLWJpbmFyeS1ibG9i/)).not.toBeInTheDocument();
  });

  it("reloads MCP servers and invalidates inventory", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.reloadMcpServers.mockResolvedValue(undefined);

    const { queryClient } = renderPreferences("mcp");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(await screen.findByRole("button", { name: /reload/i }));

    await waitFor(() => expect(apiMocks.reloadMcpServers).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpServers });
  });

  it("shows explicit OAuth login link after login starts", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [
        {
          authStatus: "notLoggedIn",
          name: "docs",
          resourceTemplates: [],
          resources: [],
          tools: {},
        },
      ],
    });
    apiMocks.startMcpOAuthLogin.mockResolvedValue({ authorizationUrl: "https://auth.example.test/login" });

    renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /log in/i }));

    const link = await screen.findByRole("link", { name: /open login/i });
    expect(link).toHaveAttribute("href", "https://auth.example.test/login");
    expect(apiMocks.startMcpOAuthLogin).toHaveBeenCalled();
    expect(apiMocks.startMcpOAuthLogin.mock.calls[0][0]).toBe("docs");
  });

  it("shows MCP loading, empty, and error states", async () => {
    apiMocks.listMcpServers.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderPreferences("mcp");
    expect(await screen.findByText("Loading MCP servers")).toBeInTheDocument();
    unmount();

    apiMocks.listMcpServers.mockReset();
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    const emptyRender = renderPreferences("mcp");
    expect(await screen.findByText("No MCP servers configured")).toBeInTheDocument();
    emptyRender.unmount();

    apiMocks.listMcpServers.mockReset();
    apiMocks.listMcpServers.mockRejectedValue(new Error("inventory failed"));
    renderPreferences("mcp");
    expect(await screen.findByText("inventory failed")).toBeInTheDocument();
  });
});
