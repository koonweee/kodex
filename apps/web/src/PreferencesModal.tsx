import { Alert, Badge, Box, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Bell, BellOff, Package, RefreshCw, Send } from "lucide-react";

import {
  getKodexControlPluginStatus,
  getNotificationStatus,
  installKodexControlPlugin,
  sendTestNotification,
} from "./api/client";
import { queryKeys } from "./api/queryKeys";
import { McpPreferencesPanel } from "./mcp/McpPreferencesPanel";
import { ExecutionPreferencesPanel } from "./preferences/ExecutionPreferencesPanel";
import { AppearancePreferencesPanel } from "./preferences/AppearancePreferencesPanel";
import type { AppearanceMode, AppearancePreferences } from "./theme/appearancePreferences";
import { requestKodexNotificationPermission } from "./notifications/browserNotifications";
import {
  browserPushNotificationsSupported,
  type BrowserPushNotificationState,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
  loadBrowserPushNotificationState,
} from "./notifications/pushSubscriptions";
import type { KodexColorSchemeId } from "./theme";

export type PreferenceSection = "appearance" | "execution" | "notifications" | "plugins" | "mcp";

export type PreferencesModalProps = {
  activeSection?: PreferenceSection;
  preferences: AppearancePreferences;
  resolvedSchemeId: KodexColorSchemeId;
  onClose: () => void;
  onModeChange: (mode: AppearanceMode) => void;
  onThemeChange: (id: KodexColorSchemeId) => void;
  onSectionChange: (section: PreferenceSection) => void;
  opened: boolean;
  executionPanel?: ReactNode;
};

export function PreferencesModal({
  activeSection = "appearance",
  preferences,
  resolvedSchemeId,
  onClose,
  onModeChange,
  onThemeChange,
  onSectionChange,
  opened,
  executionPanel,
}: PreferencesModalProps) {
  const queryClient = useQueryClient();
  const pluginStatusQuery = useQuery({
    enabled: opened && activeSection === "plugins",
    queryFn: getKodexControlPluginStatus,
    queryKey: queryKeys.kodexControlPlugin,
  });
  const notificationStatusQuery = useQuery({
    enabled: opened && activeSection === "notifications",
    queryFn: ({ signal }) => getNotificationStatus(signal),
    queryKey: queryKeys.notificationStatus,
  });
  const currentPushStateQuery = useQuery({
    enabled: opened && activeSection === "notifications",
    queryFn: ({ signal }) => loadBrowserPushNotificationState(signal),
    queryKey: ["notifications", "current-device"],
  });
  const installPluginMutation = useMutation({
    mutationFn: installKodexControlPlugin,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.kodexControlPlugin }),
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
      ]);
    },
  });
  const enableNotificationsMutation = useMutation({
    mutationFn: async () => {
      const status = notificationStatusQuery.data ?? (await getNotificationStatus());
      if (!status.vapidPublicKey) {
        throw new Error("Notifications are not configured");
      }
      const permission = await requestKodexNotificationPermission();
      if (permission !== "granted") {
        return permission;
      }
      await enableBrowserPushNotifications(status.vapidPublicKey);
      return permission;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notificationStatus }),
        queryClient.invalidateQueries({ queryKey: ["notifications", "current-device"] }),
      ]);
    },
  });
  const disableNotificationsMutation = useMutation({
    mutationFn: disableBrowserPushNotifications,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications", "current-device"] });
    },
  });
  const testNotificationMutation = useMutation({
    mutationFn: sendTestNotification,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications", "current-device"] });
    },
  });

  return (
    <Modal
      centered
      classNames={{
        body: "kodex-preferences-modal-body",
      }}
      onClose={onClose}
      opened={opened}
      size={640}
      title="Preferences"
    >
      <Box className="kodex-preferences-layout">
        <Stack className="kodex-preferences-sections" gap={4}>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "appearance" ? "true" : undefined}
            onClick={() => onSectionChange("appearance")}
            type="button"
            variant={activeSection === "appearance" ? "light" : "subtle"}
          >
            Appearance
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "execution" ? "true" : undefined}
            onClick={() => onSectionChange("execution")}
            type="button"
            variant={activeSection === "execution" ? "light" : "subtle"}
          >
            Execution
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "notifications" ? "true" : undefined}
            onClick={() => onSectionChange("notifications")}
            type="button"
            variant={activeSection === "notifications" ? "light" : "subtle"}
          >
            Notifications
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "plugins" ? "true" : undefined}
            onClick={() => onSectionChange("plugins")}
            type="button"
            variant={activeSection === "plugins" ? "light" : "subtle"}
          >
            Plugins
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "mcp" ? "true" : undefined}
            onClick={() => onSectionChange("mcp")}
            type="button"
            variant={activeSection === "mcp" ? "light" : "subtle"}
          >
            MCP
          </Button>
        </Stack>

        {activeSection === "appearance" ? (
          <AppearancePreferencesPanel
            preferences={preferences}
            resolvedSchemeId={resolvedSchemeId}
            onModeChange={onModeChange}
            onThemeChange={onThemeChange}
          />
        ) : activeSection === "execution" ? (
          executionPanel ?? <ExecutionPreferencesPanel />
        ) : activeSection === "notifications" ? (
          <NotificationsPreferencesPanel
            disableError={disableNotificationsMutation.error}
            disableSuccess={disableNotificationsMutation.isSuccess && currentPushStateQuery.data?.subscribed === false && !currentPushStateQuery.error}
            disabling={disableNotificationsMutation.isPending}
            enableError={enableNotificationsMutation.error}
            enableSuccess={enableNotificationsMutation.isSuccess && enableNotificationsMutation.data === "granted" && currentPushStateQuery.data?.subscribed === true && !currentPushStateQuery.error}
            enabling={enableNotificationsMutation.isPending}
            onDisable={() => disableNotificationsMutation.mutate()}
            onEnable={() => enableNotificationsMutation.mutate()}
            onTest={() => testNotificationMutation.mutate()}
            pushState={currentPushStateQuery.data}
            pushStateError={currentPushStateQuery.error}
            pushStateLoading={currentPushStateQuery.isLoading}
            status={notificationStatusQuery.data}
            statusError={notificationStatusQuery.error}
            statusLoading={notificationStatusQuery.isLoading}
            testError={testNotificationMutation.error}
            testResult={testNotificationMutation.data}
            testSuccess={testNotificationMutation.isSuccess}
            testing={testNotificationMutation.isPending}
          />
        ) : activeSection === "plugins" ? (
          <PluginsPreferencesPanel
            installError={installPluginMutation.error}
            installing={installPluginMutation.isPending}
            onInstall={() => installPluginMutation.mutate()}
            onRefresh={() => pluginStatusQuery.refetch()}
            status={pluginStatusQuery.data}
            statusError={pluginStatusQuery.error}
            statusLoading={pluginStatusQuery.isLoading}
          />
        ) : (
          <McpPreferencesPanel />
        )}
      </Box>
    </Modal>
  );
}

function NotificationsPreferencesPanel({
  disableError,
  disableSuccess,
  disabling,
  enableError,
  enableSuccess,
  enabling,
  onDisable,
  onEnable,
  onTest,
  pushState,
  pushStateError,
  pushStateLoading,
  status,
  statusError,
  statusLoading,
  testError,
  testResult,
  testSuccess,
  testing,
}: {
  disableError: Error | null;
  disableSuccess: boolean;
  disabling: boolean;
  enableError: Error | null;
  enableSuccess: boolean;
  enabling: boolean;
  onDisable: () => void;
  onEnable: () => void;
  onTest: () => void;
  pushState?: BrowserPushNotificationState;
  pushStateError: Error | null;
  pushStateLoading: boolean;
  status?: Awaited<ReturnType<typeof getNotificationStatus>>;
  statusError: Error | null;
  statusLoading: boolean;
  testError: Error | null;
  testResult?: Awaited<ReturnType<typeof sendTestNotification>>;
  testSuccess: boolean;
  testing: boolean;
}) {
  const pushSupported = pushState?.supported ?? browserPushNotificationsSupported();
  const pushEnabled = pushState?.subscribed === true;
  const permission = pushState?.permission ?? "default";
  const unavailable =
    !pushSupported ||
    permission === "unsupported" ||
    permission === "denied" ||
    status?.subscriptionsEnabled === false ||
    status?.configured === false;
  const checking = statusLoading || pushStateLoading;
  const stateError = statusError ?? pushStateError;
  const statusText = checking
    ? "Checking"
    : stateError
      ? "Unavailable"
      : pushEnabled
        ? "Enabled"
        : unavailable
          ? "Unavailable"
          : "Available";

  return (
    <Stack className="kodex-preferences-panel" gap={14}>
      <Group justify="space-between" wrap="nowrap">
        <Text className="kodex-preferences-panel-title" fw={650}>
          Notifications
        </Text>
        <Badge data-tone={pushEnabled ? "success" : unavailable ? "neutral" : "info"}>{statusText}</Badge>
      </Group>
      <Text c="dimmed" size="sm">
        Your device’s notification settings also control alerts and app badges.
      </Text>

      <Stack className="kodex-preferences-setting" gap={10}>
        {checking ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text c="dimmed" size="sm">
              Checking notification status
            </Text>
          </Group>
        ) : null}
        {stateError ? (
          <Alert color="red" variant="light">
            {stateError.message}
          </Alert>
        ) : null}
        {enableError ? (
          <Alert color="red" variant="light">
            {enableError.message}
          </Alert>
        ) : null}
        {disableError ? (
          <Alert color="red" variant="light">
            {disableError.message}
          </Alert>
        ) : null}
        {testError ? (
          <Alert color="red" variant="light">
            {testError.message}
          </Alert>
        ) : null}
        {enableSuccess ? (
          <Alert color="green" variant="light">
            Notifications enabled.
          </Alert>
        ) : null}
        {disableSuccess ? (
          <Alert color="green" variant="light">
            Notifications disabled.
          </Alert>
        ) : null}
        {testSuccess && testResult?.enqueued ? (
          <Alert color="green" variant="light">
            Test notification sent.
          </Alert>
        ) : null}
        {testSuccess && testResult && !testResult.enqueued ? (
          <Alert color="yellow" variant="light">
            No active notification subscriptions.
          </Alert>
        ) : null}
        <Group gap="xs">
          <Button
            disabled={checking || unavailable || enabling || pushEnabled}
            leftSection={<Bell size={15} />}
            loading={enabling}
            onClick={onEnable}
            type="button"
            variant="light"
          >
            Enable
          </Button>
          <Button
            disabled={checking || disabling || !pushEnabled}
            leftSection={<BellOff size={15} />}
            loading={disabling}
            onClick={onDisable}
            type="button"
            variant="subtle"
          >
            Disable
          </Button>
          {pushEnabled ? (
            <Button
              disabled={testing}
              leftSection={<Send size={15} />}
              loading={testing}
              onClick={onTest}
              type="button"
              variant="subtle"
            >
              Test
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Stack>
  );
}

function PluginsPreferencesPanel({
  installError,
  installing,
  onInstall,
  onRefresh,
  status,
  statusError,
  statusLoading,
}: {
  installError: Error | null;
  installing: boolean;
  onInstall: () => void;
  onRefresh: () => void;
  status?: Awaited<ReturnType<typeof getKodexControlPluginStatus>>;
  statusError: Error | null;
  statusLoading: boolean;
}) {
  const installed = status?.status === "installed";
  const blocked = status?.status === "appServerUnavailable" || status?.status === "setupError";
  const pluginStatusText = status ? pluginStatusLabel(status.status) : "Loading";
  const errorMessage = installError?.message ?? statusError?.message ?? status?.setupError ?? undefined;

  return (
    <Stack className="kodex-preferences-panel" gap={14}>
      <Group justify="space-between" wrap="nowrap">
        <Text className="kodex-preferences-panel-title" fw={650}>
          Plugins
        </Text>
        <Button
          aria-label="Refresh plugins"
          disabled={statusLoading}
          leftSection={<RefreshCw size={15} />}
          onClick={onRefresh}
          size="xs"
          type="button"
          variant="subtle"
        >
          Refresh
        </Button>
      </Group>

      <Box className="kodex-plugin-row">
        <Box aria-hidden="true" className="kodex-plugin-icon">
          <Package size={18} />
        </Box>
        <Stack className="kodex-plugin-copy" gap={5}>
          <Group gap={8} wrap="wrap">
            <Text fw={650} size="sm">
              Kodex Control
            </Text>
            <Badge color={installed ? "green" : blocked ? "red" : "gray"} size="sm" variant="light">
              {pluginStatusText}
            </Badge>
          </Group>
          <Text c="dimmed" size="xs">
            Generated apps, guarded self-control tools, and gateway-hosted MCP resources.
          </Text>
          {statusLoading ? (
            <Group gap={8}>
              <Loader size={14} />
              <Text c="dimmed" size="xs">
                Checking plugin status
              </Text>
            </Group>
          ) : null}
          {status ? (
            <Text c="dimmed" size="xs">
              {status.skills.length} skills · {status.mcpServers.length} MCP servers
            </Text>
          ) : null}
          {errorMessage ? (
            <Alert color="red" variant="light">
              {errorMessage}
            </Alert>
          ) : null}
        </Stack>
        <Button
          disabled={blocked || statusLoading}
          leftSection={installed ? <RefreshCw size={15} /> : undefined}
          loading={installing}
          onClick={onInstall}
          type="button"
          variant={installed ? "light" : "filled"}
        >
          {installed ? "Reinstall" : "Install"}
        </Button>
      </Box>
    </Stack>
  );
}

function pluginStatusLabel(status: string): string {
  switch (status) {
    case "installed":
      return "Installed";
    case "notInstalled":
      return "Available";
    case "appServerUnavailable":
      return "App-server unavailable";
    case "setupError":
      return "Setup error";
    default:
      return status;
  }
}
