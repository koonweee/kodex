import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import { PreferencesModal } from "./PreferencesModal";

const apiMocks = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  listConfiguredMcpServers: vi.fn(),
  deleteCurrentPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  getCurrentPushSubscriptionStatus: vi.fn(),
  getKodexControlPluginStatus: vi.fn(),
  getNotificationStatus: vi.fn(),
  installKodexControlPlugin: vi.fn(),
  sendTestNotification: vi.fn(),
  upsertPushSubscription: vi.fn(),
}));
const pwaMocks = vi.hoisted(() => ({ getServiceWorkerRegistration: vi.fn() }));

vi.mock("./pwa/registerServiceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pwa/registerServiceWorker")>()),
  ...pwaMocks,
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  listMcpServers: apiMocks.listMcpServers,
  listConfiguredMcpServers: apiMocks.listConfiguredMcpServers,
  deleteCurrentPushSubscription: apiMocks.deleteCurrentPushSubscription,
  deletePushSubscription: apiMocks.deletePushSubscription,
  getCurrentPushSubscriptionStatus: apiMocks.getCurrentPushSubscriptionStatus,
  getKodexControlPluginStatus: apiMocks.getKodexControlPluginStatus,
  getNotificationStatus: apiMocks.getNotificationStatus,
  installKodexControlPlugin: apiMocks.installKodexControlPlugin,
  sendTestNotification: apiMocks.sendTestNotification,
  upsertPushSubscription: apiMocks.upsertPushSubscription,
}));

function renderPreferences(initialSection: "appearance" | "execution" | "notifications" | "plugins" | "mcp" = "plugins", mcpPanel?: ReactNode, pluginsPanel?: ReactNode) {
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
    const [section, setSection] = useState<"appearance" | "execution" | "notifications" | "plugins" | "mcp">(initialSection);
    return (
      <PreferencesModal
        activeSection={section}
        mcpPanel={mcpPanel}
        pluginsPanel={pluginsPanel}
        preferences={{ mode: "dark", lightThemeId: "paper-light", darkThemeId: "oled-black" }}
        resolvedSchemeId="oled-black"
        onClose={vi.fn()}
        onModeChange={vi.fn()}
        onThemeChange={vi.fn()}
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
  registration,
}: {
  permission?: NotificationPermission;
  subscription?: PushSubscription | null;
  registration?: ServiceWorkerRegistration;
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
      getRegistration: vi.fn().mockResolvedValue(registration ?? {
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
      skills: ["generative-ui"],
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

  it("shows installed state with a reinstall action", async () => {
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
      skills: ["generative-ui"],
      status: "installed",
    });
    apiMocks.installKodexControlPlugin.mockResolvedValue({ status: {}, marketplace: null, install: null });

    const { queryClient } = renderPreferences();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findAllByText("Installed")).toHaveLength(1);
    const reinstallButton = await screen.findByRole("button", { name: /^reinstall$/i });
    expect(reinstallButton).toBeEnabled();

    await userEvent.click(reinstallButton);

    await waitFor(() => expect(apiMocks.installKodexControlPlugin).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.kodexControlPlugin }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["skills"] });
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
    pwaMocks.getServiceWorkerRegistration.mockReset();
    apiMocks.deleteCurrentPushSubscription.mockReset();
    apiMocks.deletePushSubscription.mockReset();
    apiMocks.getCurrentPushSubscriptionStatus.mockReset();
    apiMocks.getKodexControlPluginStatus.mockReset();
    apiMocks.getNotificationStatus.mockReset();
    apiMocks.sendTestNotification.mockReset();
    apiMocks.upsertPushSubscription.mockReset();
    localStorage.clear();
  });

  it.each(["registration", "subscription", "gateway"])("does not report enabled when %s fails after permission is granted", async (failure) => {
    const restoreNotifications = installNotificationEnvironment({ permission: "default" });
    apiMocks.getNotificationStatus.mockResolvedValue({ configured: true, subscriptionsEnabled: true, vapidPublicKey: "AQIDBA" });
    const error = new Error(`${failure} failed`);
    const subscription = { endpoint: "https://push.example/new-sub" } as PushSubscription;
    const subscribe = vi.fn().mockResolvedValue(subscription);
    pwaMocks.getServiceWorkerRegistration.mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } });
    apiMocks.upsertPushSubscription.mockResolvedValue({ subscription: { enabled: true } });
    if (failure === "registration") pwaMocks.getServiceWorkerRegistration.mockRejectedValue(error);
    else if (failure === "subscription") subscribe.mockRejectedValue(error);
    else apiMocks.upsertPushSubscription.mockRejectedValue(error);

    try {
      renderPreferences("notifications");
      await screen.findByText("Available");
      await userEvent.click(screen.getByRole("button", { name: /enable/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(error.message);
      expect(screen.queryByText("Notifications enabled.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /enable/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /disable/i })).toBeDisabled();
      if (failure !== "gateway") expect(apiMocks.upsertPushSubscription).not.toHaveBeenCalled();
    } finally {
      restoreNotifications();
    }
  });

  it("keeps success feedback consistent with enable, disable and later device-status refills", async () => {
    let current: PushSubscription | null = null;
    let subscribed = false;
    let statusError: Error | null = null;
    const subscription = {
      endpoint: "https://push.example/device",
      unsubscribe: vi.fn(async () => { current = null; return true; }),
    } as unknown as PushSubscription;
    const registration = { pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => { current = subscription; return subscription; }),
    } } as unknown as ServiceWorkerRegistration;
    const restoreNotifications = installNotificationEnvironment({ permission: "granted", registration });
    pwaMocks.getServiceWorkerRegistration.mockResolvedValue(registration);
    apiMocks.getNotificationStatus.mockResolvedValue({ configured: true, subscriptionsEnabled: true, vapidPublicKey: "AQIDBA" });
    apiMocks.getCurrentPushSubscriptionStatus.mockImplementation(async () => {
      if (statusError) throw statusError;
      return { configured: true, subscribed, subscription: null };
    });
    apiMocks.upsertPushSubscription.mockImplementation(async () => { subscribed = true; return { subscription: { enabled: true } }; });
    apiMocks.deleteCurrentPushSubscription.mockImplementation(async () => { subscribed = false; return { subscription: null }; });

    try {
      const { queryClient } = renderPreferences("notifications");
      await screen.findByText("Available");
      await userEvent.click(screen.getByRole("button", { name: /enable/i }));
      expect(await screen.findByText("Notifications enabled.")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /disable/i }));
      expect(await screen.findByText("Notifications disabled.")).toBeInTheDocument();
      expect(screen.queryByText("Notifications enabled.")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /enable/i }));
      expect(await screen.findByText("Notifications enabled.")).toBeInTheDocument();
      expect(screen.queryByText("Notifications disabled.")).not.toBeInTheDocument();

      subscribed = false;
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["notifications", "current-device"] }); });
      expect(await screen.findByText("Available")).toBeInTheDocument();
      expect(screen.queryByText("Notifications enabled.")).not.toBeInTheDocument();

      statusError = new Error("Device status unavailable");
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["notifications", "current-device"] }); });
      expect(await screen.findByText(statusError.message)).toBeInTheDocument();
      expect(screen.queryByText("Notifications enabled.")).not.toBeInTheDocument();
      expect(screen.queryByText("Notifications disabled.")).not.toBeInTheDocument();
    } finally {
      restoreNotifications();
    }
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
      expect(localStorage.getItem("kodex.pushSubscriptionId")).toBe("subscription-1");
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


describe('PreferencesModal MCP panel extension', () => {
  beforeEach(() => { apiMocks.listMcpServers.mockReset(); apiMocks.listConfiguredMcpServers.mockReset(); });
  it('mounts a replacement MCP panel without legacy MCP queries', async () => {
    renderPreferences('appearance', <p>Native MCP inventory</p>);
    await userEvent.click(screen.getByRole('button', { name: 'MCP' }));
    expect(screen.getByText('Native MCP inventory')).toBeInTheDocument();
    expect(apiMocks.listMcpServers).not.toHaveBeenCalled();
    expect(apiMocks.listConfiguredMcpServers).not.toHaveBeenCalled();
  });
  it('retains the existing MCP panel when no replacement is supplied', async () => {
    apiMocks.listMcpServers.mockResolvedValue({ servers: [] });
    apiMocks.listConfiguredMcpServers.mockResolvedValue({ servers: [], writeTarget: null });
    renderPreferences('mcp');
    expect(await screen.findByText('No MCP servers configured')).toBeInTheDocument();
    expect(apiMocks.listMcpServers).toHaveBeenCalledOnce();
    expect(apiMocks.listConfiguredMcpServers).toHaveBeenCalledOnce();
  });
});


describe('PreferencesModal Plugins panel extension', () => {
  beforeEach(() => { apiMocks.getKodexControlPluginStatus.mockReset(); apiMocks.installKodexControlPlugin.mockReset(); });
  it('navigates to a replacement Plugins panel without legacy plugin requests', async () => {
    renderPreferences('appearance', undefined, <p>Built-in native Control</p>);
    await userEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(screen.getByText('Built-in native Control')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install|Reinstall|Refresh plugins/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.queryByText('Built-in native Control')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(screen.getByText('Built-in native Control')).toBeInTheDocument();
    expect(apiMocks.getKodexControlPluginStatus).not.toHaveBeenCalled();
    expect(apiMocks.installKodexControlPlugin).not.toHaveBeenCalled();
  });
});

it('preserves an app-server plugin installation in progress across section navigation', async () => {
  apiMocks.getKodexControlPluginStatus.mockReset().mockResolvedValue({ status: 'installed', skills: [], mcpServers: [] });
  let finish!: () => void;
  apiMocks.installKodexControlPlugin.mockReset().mockImplementation(() => new Promise((_resolve, reject) => { finish = () => reject(new Error('Installation failed')); }));
  renderPreferences('plugins');
  await userEvent.click(await screen.findByRole('button', { name: 'Reinstall' }));
  await userEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  await userEvent.click(screen.getByRole('button', { name: 'Plugins' }));
  expect(screen.getByRole('button', { name: 'Reinstall' })).toBeDisabled();
  await act(async () => finish());
  expect(await screen.findByRole('alert')).toHaveTextContent('Installation failed');
  expect(apiMocks.installKodexControlPlugin).toHaveBeenCalledOnce();
});
