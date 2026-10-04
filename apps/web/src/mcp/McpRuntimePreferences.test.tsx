import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../api/queryKeys";
import { McpPreferencesPanel } from "./McpPreferencesPanel";

const apiMocks = vi.hoisted(() => ({
  listConfiguredMcpServers: vi.fn(), listMcpServers: vi.fn(), readMcpResource: vi.fn(),
  reloadMcpServers: vi.fn(), startMcpOAuthLogin: vi.fn(),
}));
vi.mock("../api/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/client")>()), ...apiMocks }));
function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { queryClient, ...render(<QueryClientProvider client={queryClient}><MantineProvider env="test"><McpPreferencesPanel /></MantineProvider></QueryClientProvider>) };
}

describe("MCP runtime preferences", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.listConfiguredMcpServers.mockResolvedValue({ servers: [], writeTarget: null });
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

    renderPanel();

    expect((await screen.findAllByText("docs")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /refresh mcp servers/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 tools · 1 resources · 1 templates")).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();
    expect(screen.getByText("Doc Template")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /README/ }));

    expect(await screen.findByText("# Docs")).toBeInTheDocument();
    expect(apiMocks.readMcpResource).toHaveBeenCalledWith("docs", "file:///docs/readme.md");
  });

  it("shows native connection and tool-discovery failure without treating OAuth as a loaded runtime", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [{
        authStatus: "oAuth",
        name: "docs",
        runtimeStatus: "failed",
        toolsError: "Tool catalog unavailable",
        resourceTemplates: [],
        resources: [],
        tools: {},
      }],
    });

    renderPanel();

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Tool catalog unavailable");
    expect(screen.getAllByText("OAuth").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loaded")).not.toBeInTheDocument();
    expect(screen.queryByText("No tools reported")).not.toBeInTheDocument();
    expect(screen.queryByText(/^0 tools/)).not.toBeInTheDocument();
  });

  it.each([
    ["starting", "Starting"],
    [null, "Status unavailable"],
  ] as const)("does not infer a loaded runtime from native status %s", async (runtimeStatus, label) => {
    apiMocks.listMcpServers.mockResolvedValue({
      servers: [{
        authStatus: "notLoggedIn",
        name: "docs",
        runtimeStatus,
        resourceTemplates: [],
        resources: [],
        tools: {},
      }],
    });

    renderPanel();

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Loaded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log in/i })).toBeInTheDocument();
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

    renderPanel();

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
    const loadingRender = renderPanel();

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
    renderPanel();

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

    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /Logo/ }));

    expect(await screen.findByText(/Unsupported binary resource/)).toBeInTheDocument();
    expect(screen.getByText(/MIME type: image\/png/)).toBeInTheDocument();
    expect(screen.getByText(/Encoded payload length: \d+ characters/)).toBeInTheDocument();
    expect(screen.queryByText(/VGhpcy1pcy1hLWJpbmFyeS1ibG9i/)).not.toBeInTheDocument();
  });

  it("reloads MCP servers and invalidates inventory", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.reloadMcpServers.mockResolvedValue({ queued: true, error: null });

    const { queryClient } = renderPanel();
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

    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /log in/i }));

    const link = await screen.findByRole("link", { name: /open login/i });
    expect(link).toHaveAttribute("href", "https://auth.example.test/login");
    expect(apiMocks.startMcpOAuthLogin).toHaveBeenCalled();
    expect(apiMocks.startMcpOAuthLogin.mock.calls[0][0]).toBe("docs");
  });

  it.each(["success", "error"] as const)("ignores a late OAuth %s after selecting another server and returning", async (outcome) => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: ["docs", "other"].map((name) => ({
      name, authStatus: "notLoggedIn", resourceTemplates: [], resources: [], tools: {},
    })) });
    let resolve!: (value: { authorizationUrl: string }) => void;
    let reject!: (error: Error) => void;
    apiMocks.startMcpOAuthLogin.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /log in/i }));
    await userEvent.click(screen.getByRole("button", { name: /^other / }));
    await act(async () => {
      if (outcome === "success") resolve({ authorizationUrl: "https://auth.example.test/old-docs" });
      else reject(new Error("Old docs login failed"));
    });

    expect(screen.queryByRole("link", { name: /open login/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Old docs login failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log in/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /^docs / }));
    expect(screen.queryByRole("link", { name: /open login/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Old docs login failed")).not.toBeInTheDocument();
  });

  it.each(["success", "error"] as const)("keeps the newer same-server OAuth attempt after an older %s", async (outcome) => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [{
      name: "docs", authStatus: "notLoggedIn", resourceTemplates: [], resources: [], tools: {},
    }] });
    let resolve!: (value: { authorizationUrl: string }) => void;
    let reject!: (error: Error) => void;
    apiMocks.startMcpOAuthLogin
      .mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }))
      .mockResolvedValueOnce({ authorizationUrl: "https://auth.example.test/new-docs" });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /log in/i }));
    await userEvent.click(screen.getByRole("button", { name: /^docs / }));
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    expect(await screen.findByRole("link", { name: /open login/i })).toHaveAttribute("href", "https://auth.example.test/new-docs");
    await act(async () => {
      if (outcome === "success") resolve({ authorizationUrl: "https://auth.example.test/old-docs" });
      else reject(new Error("Old docs login failed"));
    });

    expect(screen.getByRole("link", { name: /open login/i })).toHaveAttribute("href", "https://auth.example.test/new-docs");
    expect(screen.queryByText("Old docs login failed")).not.toBeInTheDocument();
    expect(apiMocks.startMcpOAuthLogin.mock.calls.map(([name]) => name)).toEqual(["docs", "docs"]);
  });

  it("shows the current attempt's error and replaces it when the user retries", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [{
      name: "docs", authStatus: "notLoggedIn", resourceTemplates: [], resources: [], tools: {},
    }] });
    apiMocks.startMcpOAuthLogin
      .mockRejectedValueOnce(new Error("Current login could not start"))
      .mockResolvedValueOnce({ authorizationUrl: "https://auth.example.test/retry" });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /log in/i }));
    expect(await screen.findByText("Current login could not start")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    expect(await screen.findByRole("link", { name: /open login/i })).toHaveAttribute("href", "https://auth.example.test/retry");
    expect(screen.queryByText("Current login could not start")).not.toBeInTheDocument();
  });

  it("shows MCP loading, empty, and error states", async () => {
    apiMocks.listMcpServers.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderPanel();
    expect(await screen.findByText("Loading MCP servers")).toBeInTheDocument();
    unmount();

    apiMocks.listMcpServers.mockReset();
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    const emptyRender = renderPanel();
    expect(await screen.findByText("No MCP servers configured")).toBeInTheDocument();
    emptyRender.unmount();

    apiMocks.listMcpServers.mockReset();
    apiMocks.listMcpServers.mockRejectedValue(new Error("inventory failed"));
    renderPanel();
    expect(await screen.findByText("inventory failed")).toBeInTheDocument();
  });

});
