import { Alert, Badge, Box, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, Package, RefreshCw } from "lucide-react";
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";

import { getKodexControlPluginStatus, getNotificationStatus, installKodexControlPlugin } from "./api/client";
import { queryKeys } from "./api/queryKeys";
import { McpPreferencesPanel } from "./mcp/McpPreferencesPanel";
import {
  notificationPermission,
  requestKodexNotificationPermission,
} from "./notifications/browserNotifications";
import type { BrowserNotificationPermission } from "./notifications/notificationTypes";
import {
  browserPushNotificationsSupported,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
} from "./notifications/pushSubscriptions";
import { KODEX_COLOR_SCHEMES, type KodexColorSchemeId } from "./theme";

export type PreferenceSection = "appearance" | "notifications" | "plugins" | "mcp";

type PreferencesModalProps = {
  activeSection?: PreferenceSection;
  colorSchemeId: KodexColorSchemeId;
  onClose: () => void;
  onColorSchemeChange: (colorSchemeId: KodexColorSchemeId) => void;
  onSectionChange: (section: PreferenceSection) => void;
  opened: boolean;
};

export function PreferencesModal({
  activeSection = "appearance",
  colorSchemeId,
  onClose,
  onColorSchemeChange,
  onSectionChange,
  opened,
}: PreferencesModalProps) {
  const optionRefs = useRef<Partial<Record<KodexColorSchemeId, HTMLButtonElement | null>>>({});
  const queryClient = useQueryClient();
  const pluginStatusQuery = useQuery({
    enabled: opened && activeSection === "plugins",
    queryFn: getKodexControlPluginStatus,
    queryKey: queryKeys.kodexControlPlugin,
  });
  const notificationStatusQuery = useQuery({
    enabled: opened && activeSection === "notifications",
    queryFn: getNotificationStatus,
    queryKey: queryKeys.notificationStatus,
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.notificationStatus });
    },
  });
  const disableNotificationsMutation = useMutation({
    mutationFn: disableBrowserPushNotifications,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notificationStatus });
    },
  });

  function handleSchemeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % KODEX_COLOR_SCHEMES.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + KODEX_COLOR_SCHEMES.length) % KODEX_COLOR_SCHEMES.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = KODEX_COLOR_SCHEMES.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextScheme = KODEX_COLOR_SCHEMES[nextIndex];
    onColorSchemeChange(nextScheme.id);
    optionRefs.current[nextScheme.id]?.focus();
  }

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
            colorSchemeId={colorSchemeId}
            handleSchemeKeyDown={handleSchemeKeyDown}
            onColorSchemeChange={onColorSchemeChange}
            optionRefs={optionRefs}
          />
        ) : activeSection === "notifications" ? (
          <NotificationsPreferencesPanel
            disabling={disableNotificationsMutation.isPending}
            enableError={enableNotificationsMutation.error}
            enabling={enableNotificationsMutation.isPending}
            onDisable={() => disableNotificationsMutation.mutate()}
            onEnable={() => enableNotificationsMutation.mutate()}
            permission={notificationPermission()}
            status={notificationStatusQuery.data}
            statusError={notificationStatusQuery.error}
            statusLoading={notificationStatusQuery.isLoading}
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
  disabling,
  enableError,
  enabling,
  onDisable,
  onEnable,
  permission,
  status,
  statusError,
  statusLoading,
}: {
  disabling: boolean;
  enableError: Error | null;
  enabling: boolean;
  onDisable: () => void;
  onEnable: () => void;
  permission: BrowserNotificationPermission;
  status?: Awaited<ReturnType<typeof getNotificationStatus>>;
  statusError: Error | null;
  statusLoading: boolean;
}) {
  const pushSupported = browserPushNotificationsSupported();
  const unavailable =
    !pushSupported ||
    permission === "unsupported" ||
    status?.subscriptionsEnabled === false ||
    status?.configured === false;
  const statusText = statusLoading
    ? "Checking"
    : statusError
      ? "Unavailable"
      : permission === "granted"
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
        <Badge data-tone={permission === "granted" ? "success" : unavailable ? "neutral" : "info"}>{statusText}</Badge>
      </Group>

      <Stack className="kodex-preferences-setting" gap={10}>
        {statusLoading ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text c="dimmed" size="sm">
              Checking notification status
            </Text>
          </Group>
        ) : null}
        {statusError ? (
          <Alert color="red" variant="light">
            {statusError.message}
          </Alert>
        ) : null}
        {enableError ? (
          <Alert color="red" variant="light">
            {enableError.message}
          </Alert>
        ) : null}
        <Group gap="xs">
          <Button
            disabled={unavailable || enabling || permission === "granted"}
            leftSection={<Bell size={15} />}
            loading={enabling}
            onClick={onEnable}
            type="button"
            variant="light"
          >
            Enable
          </Button>
          <Button
            disabled={disabling || permission !== "granted"}
            leftSection={<BellOff size={15} />}
            loading={disabling}
            onClick={onDisable}
            type="button"
            variant="subtle"
          >
            Disable
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}

function AppearancePreferencesPanel({
  colorSchemeId,
  handleSchemeKeyDown,
  onColorSchemeChange,
  optionRefs,
}: {
  colorSchemeId: KodexColorSchemeId;
  handleSchemeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  onColorSchemeChange: (colorSchemeId: KodexColorSchemeId) => void;
  optionRefs: MutableRefObject<Partial<Record<KodexColorSchemeId, HTMLButtonElement | null>>>;
}) {
  return (
    <Stack className="kodex-preferences-panel" gap={14}>
      <Text className="kodex-preferences-panel-title" fw={650}>
        Appearance
      </Text>

      <Stack className="kodex-preferences-setting" gap={8}>
        <Box className="kodex-preferences-setting-header">
          <Text fw={600} id="kodex-color-scheme-label" size="sm">
            Color scheme
          </Text>
        </Box>

        <Box aria-labelledby="kodex-color-scheme-label" className="kodex-scheme-list" role="radiogroup">
          {KODEX_COLOR_SCHEMES.map((scheme, index) => (
            <Button
              aria-checked={scheme.id === colorSchemeId}
              className="kodex-scheme-option"
              data-active={scheme.id === colorSchemeId ? "true" : undefined}
              key={scheme.id}
              onClick={() => onColorSchemeChange(scheme.id)}
              onKeyDown={(event) => handleSchemeKeyDown(event, index)}
              ref={(node) => {
                optionRefs.current[scheme.id] = node;
              }}
              role="radio"
              tabIndex={scheme.id === colorSchemeId ? 0 : -1}
              type="button"
              variant={scheme.id === colorSchemeId ? "light" : "subtle"}
            >
              <Box className="kodex-scheme-copy">
                <Text className="kodex-scheme-label" fw={600}>
                  {scheme.label}
                </Text>
              </Box>
              <Box aria-hidden="true" className="kodex-scheme-swatches">
                {scheme.swatches.map((color) => (
                  <span className="kodex-scheme-swatch" key={color} style={{ background: color }} />
                ))}
              </Box>
            </Button>
          ))}
        </Box>
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
            Proxy evaluation, guarded self-control tools, and gateway-hosted MCP resources.
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
          disabled={installed || blocked || statusLoading}
          leftSection={installed ? <Check size={15} /> : undefined}
          loading={installing}
          onClick={onInstall}
          type="button"
          variant={installed ? "light" : "filled"}
        >
          {installed ? "Installed" : "Install"}
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
