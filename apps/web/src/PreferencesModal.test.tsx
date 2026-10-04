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
  deleteCurrentPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  getCurrentPushSubscriptionStatus: vi.fn(),
  getKodexControlPluginStatus: vi.fn(),
  getNotificationStatus: vi.fn(),
  installKodexControlPlugin: vi.fn(),
  sendTestNotification: vi.fn(),
  upsertPushSubscription: vi.fn(),
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
}));

function renderPreferences(initialSection: "appearance" | "execution" | "notifications" | "plugins" | "mcp" = "plugins") {
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
