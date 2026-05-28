import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import { PreferencesModal } from "./PreferencesModal";

const apiMocks = vi.hoisted(() => ({
  deleteCurrentPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  getCurrentPushSubscriptionStatus: vi.fn(),
  getKodexControlPluginStatus: vi.fn(),
  getNotificationStatus: vi.fn(),
  installKodexControlPlugin: vi.fn(),
  sendTestNotification: vi.fn(),
  upsertPushSubscription: vi.fn(),
  addMcpServer: vi.fn(),
  listConfiguredMcpServers: vi.fn(),
  listMcpServers: vi.fn(),
  readMcpResource: vi.fn(),
  reloadMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  replaceMcpServer: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  startMcpOAuthLogin: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  deleteCurrentPushSubscription: apiMocks.deleteCurrentPushSubscription,
  deletePushSubscription: apiMocks.deletePushSubscription,
  getCurrentPushSubscriptionStatus: apiMocks.getCurrentPushSubscriptionStatus,
  getKodexControlPluginStatus: apiMocks.getKodexControlPluginStatus,
  getNotificationStatus: apiMocks.getNotificationStatus,
  installKodexControlPlugin: apiMocks.installKodexControlPlugin,
  sendTestNotification: apiMocks.sendTestNotification,
  upsertPushSubscription: apiMocks.upsertPushSubscription,
  addMcpServer: apiMocks.addMcpServer,
  listConfiguredMcpServers: apiMocks.listConfiguredMcpServers,
  listMcpServers: apiMocks.listMcpServers,
  readMcpResource: apiMocks.readMcpResource,
  reloadMcpServers: apiMocks.reloadMcpServers,
  removeMcpServer: apiMocks.removeMcpServer,
  replaceMcpServer: apiMocks.replaceMcpServer,
  setMcpServerEnabled: apiMocks.setMcpServerEnabled,
  startMcpOAuthLogin: apiMocks.startMcpOAuthLogin,
}));

function renderPreferences(initialSection: "appearance" | "notifications" | "plugins" | "mcp" = "plugins") {
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
    const [section, setSection] = useState<"appearance" | "notifications" | "plugins" | "mcp">(initialSection);
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

function installNotificationEnvironment({
  permission = "default",
  subscription = null,
}: {
  permission?: NotificationPermission;
  subscription?: PushSubscription | null;
} = {}) {
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const originalPushManager = Object.getOwnPropertyDescriptor(globalThis, "PushManager");
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const notificationConstructor = vi.fn();
  Object.defineProperty(notificationConstructor, "permission", {
    configurable: true,
    value: permission,
  });
  Object.defineProperty(notificationConstructor, "requestPermission", {
    configurable: true,
    value: vi.fn().mockResolvedValue("granted"),
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: notificationConstructor,
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
        },
      }),
      ready: Promise.resolve(undefined),
    },
  });

  return () => {
    restoreDescriptor(globalThis, "Notification", originalNotification);
    restoreDescriptor(globalThis, "PushManager", originalPushManager);
    restoreDescriptor(navigator, "serviceWorker", originalServiceWorker);
  };
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

describe("PreferencesModal plugins tab", () => {
  beforeEach(() => {
    apiMocks.deleteCurrentPushSubscription.mockReset();
    apiMocks.deletePushSubscription.mockReset();
    apiMocks.getCurrentPushSubscriptionStatus.mockReset();
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.getNotificationStatus.mockReset();
    apiMocks.sendTestNotification.mockReset();
    apiMocks.upsertPushSubscription.mockReset();
    apiMocks.installKodexControlPlugin.mockReset();
    apiMocks.addMcpServer.mockReset();
    apiMocks.listConfiguredMcpServers.mockReset();
    apiMocks.listMcpServers.mockReset();
    apiMocks.readMcpResource.mockReset();
    apiMocks.reloadMcpServers.mockReset();
    apiMocks.removeMcpServer.mockReset();
    apiMocks.replaceMcpServer.mockReset();
    apiMocks.setMcpServerEnabled.mockReset();
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

describe("PreferencesModal notifications tab", () => {
  beforeEach(() => {
    apiMocks.deleteCurrentPushSubscription.mockReset();
    apiMocks.deletePushSubscription.mockReset();
    apiMocks.getCurrentPushSubscriptionStatus.mockReset();
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.getNotificationStatus.mockReset();
    apiMocks.sendTestNotification.mockReset();
    apiMocks.upsertPushSubscription.mockReset();
    localStorage.clear();
  });

  it("shows notification availability without iOS-specific guidance", async () => {
    const restoreNotifications = installNotificationEnvironment({ permission: "default" });

    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });

    try {
      renderPreferences("notifications");

      await waitFor(() => expect(screen.getAllByText("Notifications").length).toBeGreaterThan(1));
      expect(await screen.findByText("Available")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /enable/i })).toBeInTheDocument();
      expect(screen.queryByText(/ios/i)).not.toBeInTheDocument();
    } finally {
      restoreNotifications();
    }
  });

  it("keeps notification enablement unavailable without Push API support", async () => {
    const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
    const originalPushManager = Object.getOwnPropertyDescriptor(globalThis, "PushManager");
    const notificationConstructor = vi.fn();
    Object.defineProperty(notificationConstructor, "permission", {
      configurable: true,
      value: "default",
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: notificationConstructor,
    });
    Reflect.deleteProperty(globalThis, "PushManager");

    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /enable/i })).toBeDisabled();
    } finally {
      if (originalNotification) {
        Object.defineProperty(globalThis, "Notification", originalNotification);
      } else {
        Reflect.deleteProperty(globalThis, "Notification");
      }
      if (originalPushManager) {
        Object.defineProperty(globalThis, "PushManager", originalPushManager);
      } else {
        Reflect.deleteProperty(globalThis, "PushManager");
      }
    }
  });

  it("does not treat a stale localStorage subscription id as enabled", async () => {
    const restoreNotifications = installNotificationEnvironment({ permission: "granted" });
    localStorage.setItem("kodex.pushSubscriptionId", "subscription-1");
    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Available")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /enable/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /disable/i })).toBeDisabled();
      await waitFor(() => expect(localStorage.getItem("kodex.pushSubscriptionId")).toBeNull());
      expect(apiMocks.deletePushSubscription).not.toHaveBeenCalled();
    } finally {
      restoreNotifications();
    }
  });

  it("shows notifications as available after disabling while browser permission remains granted", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = { endpoint: "https://push.example/sub", unsubscribe } as unknown as PushSubscription;
    const restoreNotifications = installNotificationEnvironment({ permission: "granted", subscription });
    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });
    apiMocks.getCurrentPushSubscriptionStatus
      .mockResolvedValueOnce({
        configured: true,
        subscribed: true,
        subscription: null,
      })
      .mockResolvedValue({
        configured: true,
        subscribed: false,
        subscription: null,
      });
    apiMocks.deleteCurrentPushSubscription.mockResolvedValue({
      subscription: {
        createdAt: "2026-05-15T00:00:00Z",
        enabled: false,
        endpoint: subscription.endpoint,
        id: "subscription-1",
        updatedAt: "2026-05-15T00:00:00Z",
        userAgent: null,
      },
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Enabled")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /disable/i }));

      await waitFor(() => expect(apiMocks.deleteCurrentPushSubscription).toHaveBeenCalledWith(subscription.endpoint));
      expect(unsubscribe).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
      expect(screen.getByText("Notifications disabled.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /enable/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /disable/i })).toBeDisabled();
    } finally {
      restoreNotifications();
    }
  });

  it("shows a test action only when subscribed and reports mutation feedback", async () => {
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const restoreNotifications = installNotificationEnvironment({ permission: "granted", subscription });
    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });
    apiMocks.getCurrentPushSubscriptionStatus.mockResolvedValue({
      configured: true,
      subscribed: true,
      subscription: null,
    });
    apiMocks.sendTestNotification.mockResolvedValue({
      activeSubscriptionCount: 1,
      configured: true,
      deliveryIds: ["delivery-1"],
      enqueued: true,
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Enabled")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /test/i }));

      await waitFor(() => expect(apiMocks.sendTestNotification).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("Test notification sent.")).toBeInTheDocument();
    } finally {
      restoreNotifications();
    }
  });

  it("reports when a test notification request does not enqueue a delivery", async () => {
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const restoreNotifications = installNotificationEnvironment({ permission: "granted", subscription });
    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });
    apiMocks.getCurrentPushSubscriptionStatus.mockResolvedValue({
      configured: true,
      subscribed: true,
      subscription: null,
    });
    apiMocks.sendTestNotification.mockResolvedValue({
      activeSubscriptionCount: 0,
      configured: true,
      deliveryIds: [],
      enqueued: false,
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Enabled")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /test/i }));

      await waitFor(() => expect(apiMocks.sendTestNotification).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("No active notification subscriptions.")).toBeInTheDocument();
      expect(screen.queryByText("Test notification sent.")).not.toBeInTheDocument();
    } finally {
      restoreNotifications();
    }
  });

  it("hides the test action when the gateway reports the endpoint disabled", async () => {
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const restoreNotifications = installNotificationEnvironment({ permission: "granted", subscription });
    apiMocks.getNotificationStatus.mockResolvedValue({
      configured: true,
      subscriptionsEnabled: true,
      vapidPublicKey: "AQIDBA",
    });
    apiMocks.getCurrentPushSubscriptionStatus.mockResolvedValue({
      configured: true,
      subscribed: false,
      subscription: null,
    });

    try {
      renderPreferences("notifications");

      expect(await screen.findByText("Available")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /test/i })).not.toBeInTheDocument();
    } finally {
      restoreNotifications();
    }
  });
});

describe("PreferencesModal MCP tab", () => {
  beforeEach(() => {
    apiMocks.deleteCurrentPushSubscription.mockReset();
    apiMocks.deletePushSubscription.mockReset();
    apiMocks.getCurrentPushSubscriptionStatus.mockReset();
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.installKodexControlPlugin.mockReset();
    apiMocks.sendTestNotification.mockReset();
    apiMocks.upsertPushSubscription.mockReset();
    apiMocks.addMcpServer.mockReset();
    apiMocks.listConfiguredMcpServers.mockReset();
    apiMocks.listMcpServers.mockReset();
    apiMocks.readMcpResource.mockReset();
    apiMocks.reloadMcpServers.mockReset();
    apiMocks.removeMcpServer.mockReset();
    apiMocks.replaceMcpServer.mockReset();
    apiMocks.setMcpServerEnabled.mockReset();
    apiMocks.startMcpOAuthLogin.mockReset();
    apiMocks.listConfiguredMcpServers.mockResolvedValue({ servers: [] });
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

  it("adds an HTTP MCP server with inline header warning fields", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.addMcpServer.mockResolvedValue({ configuredServer: null, reload: { reloaded: true } });

    renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /add server/i }));
    const installDialog = await screen.findByRole("dialog", { name: /add mcp server/i });
    const install = within(installDialog);
    await userEvent.type(install.getByLabelText("Name"), "remote");
    await userEvent.type(install.getByLabelText("URL"), "https://mcp.example.test");
    await userEvent.type(install.getByLabelText("HTTP headers"), "Authorization=Bearer secret");
    expect(install.getByText("HTTP headers")).toBeInTheDocument();

    await userEvent.click(install.getByRole("button", { name: /^add server$/i }));

    await waitFor(() => expect(apiMocks.addMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMocks.addMcpServer.mock.calls[0]?.[0]).toEqual({
      enabled: true,
      name: "remote",
      transport: {
        httpHeaders: { Authorization: "Bearer secret" },
        type: "streamableHttp",
        url: "https://mcp.example.test",
      },
    });
  });

  it("confirms local command execution before adding a stdio MCP server", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.addMcpServer.mockResolvedValue({ configuredServer: null, reload: { reloaded: true } });

    renderPreferences("mcp");

    await userEvent.click(await screen.findByRole("button", { name: /add server/i }));
    const installDialog = await screen.findByRole("dialog", { name: /add mcp server/i });
    const install = within(installDialog);
    await userEvent.click(install.getByRole("radio", { name: /local command/i }));
    await userEvent.type(install.getByLabelText("Name"), "local");
    await userEvent.type(install.getByLabelText("Command"), "npx");
    await userEvent.type(install.getByLabelText("Arguments"), "-y @docs/mcp");
    await userEvent.type(install.getByLabelText("Working directory"), "/tmp/docs");
    await userEvent.type(install.getByLabelText("Environment values"), "DOCS_TOKEN=secret");
    await userEvent.type(install.getByLabelText("Environment variable names"), "SHARED_TOKEN");
    await userEvent.click(install.getByLabelText("Required"));
    expect(install.queryByLabelText("Scopes")).not.toBeInTheDocument();
    expect(install.queryByLabelText("Enabled tools")).not.toBeInTheDocument();
    expect(install.queryByLabelText("Startup timeout seconds")).not.toBeInTheDocument();
    expect(install.queryByLabelText("Tool timeout seconds")).not.toBeInTheDocument();

    await userEvent.click(install.getByRole("button", { name: /^confirm$/i }));
    expect(install.getByText("Codex will run this command locally when loading the MCP server.")).toBeInTheDocument();

    await userEvent.click(install.getByRole("button", { name: /^add server$/i }));

    await waitFor(() => expect(apiMocks.addMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMocks.addMcpServer.mock.calls[0]?.[0]).toEqual({
      enabled: true,
      name: "local",
      required: true,
      transport: {
        args: ["-y", "@docs/mcp"],
        command: "npx",
        cwd: "/tmp/docs",
        env: { DOCS_TOKEN: "secret" },
        envVars: ["SHARED_TOKEN"],
        type: "stdio",
      },
    });
  });

  it("opens replace with a clean form after a canceled add draft", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.listConfiguredMcpServers.mockResolvedValue({
      servers: [
        {
          enabled: true,
          hasStoredSecrets: false,
          name: "docs",
          transport: {
            command: "npx",
            type: "stdio",
          },
        },
      ],
    });

    renderPreferences("mcp");

    expect((await screen.findAllByText("docs")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /add server/i }));
    const addDialog = await screen.findByRole("dialog", { name: /add mcp server/i });
    const add = within(addDialog);
    await userEvent.click(add.getByRole("radio", { name: /local command/i }));
    await userEvent.type(add.getByLabelText("Name"), "draft");
    await userEvent.type(add.getByLabelText("Command"), "draft-command");
    await userEvent.click(add.getByRole("button", { name: /cancel/i }));

    await userEvent.click(screen.getByRole("button", { name: /replace/i }));
    const replaceDialog = await screen.findByRole("dialog", { name: /replace mcp server/i });
    const replace = within(replaceDialog);
    expect(replace.getByLabelText("Name")).toHaveValue("docs");
    expect(replace.getByRole("radio", { name: /local command/i })).toBeChecked();
    expect(replace.getByLabelText("Command")).toHaveValue("npx");
    expect(replace.queryByDisplayValue("draft-command")).not.toBeInTheDocument();
  });

  it("replaces and clears stored MCP secret fields without showing their values", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.listConfiguredMcpServers.mockResolvedValue({
      servers: [
        {
          enabled: true,
          hasStoredSecrets: true,
          name: "docs",
          transport: {
            httpHeaders: { Authorization: { configured: true, masked: true } },
            type: "streamableHttp",
            url: "https://mcp.example.test",
          },
        },
      ],
    });
    apiMocks.replaceMcpServer.mockResolvedValue({ configuredServer: null, reload: { reloaded: true } });

    renderPreferences("mcp");

    expect((await screen.findAllByText("docs")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /replace/i }));
    const replaceDialog = await screen.findByRole("dialog", { name: /replace mcp server/i });
    const replace = within(replaceDialog);
    expect(replace.getByText("Stored HTTP headers")).toBeInTheDocument();
    expect(replace.getByText("Authorization")).toBeInTheDocument();
    expect(replace.getByText("Stored value")).toBeInTheDocument();
    expect(screen.queryByText("Bearer secret")).not.toBeInTheDocument();

    await userEvent.click(replace.getByRole("button", { name: /^replace$/i }));
    await userEvent.type(replace.getByLabelText("Replacement value for Authorization"), "Bearer new");
    await userEvent.click(replace.getByRole("button", { name: /^clear$/i }));
    expect(replace.getByText("Will clear")).toBeInTheDocument();

    await userEvent.click(replace.getByRole("button", { name: /^confirm$/i }));
    expect(replace.getByText("Replacing this server writes exactly the submitted config. Existing stored env/header values may be replaced or cleared.")).toBeInTheDocument();
    await userEvent.click(replace.getByRole("button", { name: /^replace server$/i }));

    await waitFor(() => expect(apiMocks.replaceMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMocks.replaceMcpServer.mock.calls[0]?.[0]).toBe("docs");
    expect(apiMocks.replaceMcpServer.mock.calls[0]?.[1]).toEqual({
      enabled: true,
      name: "docs",
      transport: {
        clearHttpHeaders: ["Authorization"],
        httpHeaders: {},
        type: "streamableHttp",
        url: "https://mcp.example.test",
      },
    });
  });

  it("manages configured MCP rows without exposing stored secret values", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.listConfiguredMcpServers.mockResolvedValue({
      servers: [
        {
          enabled: true,
          hasStoredSecrets: true,
          name: "docs",
          transport: {
            command: "npx",
            env: { DOCS_TOKEN: { configured: true, masked: true } },
            type: "stdio",
          },
        },
      ],
    });
    apiMocks.setMcpServerEnabled.mockResolvedValue({ configuredServer: null, reload: { reloaded: true } });
    apiMocks.removeMcpServer.mockResolvedValue({ configuredServer: null, reload: { reloaded: true } });

    renderPreferences("mcp");

    expect((await screen.findAllByText("docs")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
    expect(screen.getByText("This server has stored env/header values in local Codex config. Values are hidden in Kodex.")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /disable/i }));
    await waitFor(() => expect(apiMocks.setMcpServerEnabled).toHaveBeenCalledWith("docs", false));

    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(screen.getByRole("button", { name: /confirm remove/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /confirm remove/i }));
    await waitFor(() => expect(apiMocks.removeMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMocks.removeMcpServer.mock.calls[0]?.[0]).toBe("docs");
  });
});
