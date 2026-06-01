import { Alert, Badge, Box, Button, Group, Loader, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, Package, RefreshCw, Send, Shield } from "lucide-react";
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";

import {
  getComposerSettings,
  getKodexControlPluginStatus,
  getNotificationStatus,
  installKodexControlPlugin,
  listPermissionProfiles,
  persistComposerSettings,
  sendTestNotification,
} from "./api/client";
import { queryKeys } from "./api/queryKeys";
import { McpPreferencesPanel } from "./mcp/McpPreferencesPanel";
import { requestKodexNotificationPermission } from "./notifications/browserNotifications";
import {
  browserPushNotificationsSupported,
  type BrowserPushNotificationState,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
  loadBrowserPushNotificationState,
} from "./notifications/pushSubscriptions";
import { KODEX_COLOR_SCHEMES, type KodexColorSchemeId } from "./theme";

export type PreferenceSection = "appearance" | "execution" | "notifications" | "plugins" | "mcp";

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
  const executionSettingsQuery = useQuery({
    enabled: opened && activeSection === "execution",
    queryFn: () => getComposerSettings(null),
    queryKey: queryKeys.composerSettings(null),
  });
  const permissionProfilesQuery = useQuery({
    enabled: opened && activeSection === "execution",
    queryFn: () => listPermissionProfiles(null),
    queryKey: queryKeys.permissionProfiles(null),
  });
  const currentPushStateQuery = useQuery({
    enabled: opened && activeSection === "notifications",
    queryFn: loadBrowserPushNotificationState,
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
  const executionSettingsMutation = useMutation({
    mutationFn: persistComposerSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.composerSettingsRoot, refetchType: "all" });
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
            colorSchemeId={colorSchemeId}
            handleSchemeKeyDown={handleSchemeKeyDown}
            onColorSchemeChange={onColorSchemeChange}
            optionRefs={optionRefs}
          />
        ) : activeSection === "execution" ? (
          <ExecutionPreferencesPanel
            profiles={permissionProfilesQuery.data}
            profilesError={permissionProfilesQuery.error}
            profilesLoading={permissionProfilesQuery.isLoading}
            saving={executionSettingsMutation.isPending}
            saveError={executionSettingsMutation.error}
            settings={executionSettingsQuery.data}
            settingsError={executionSettingsQuery.error}
            settingsLoading={executionSettingsQuery.isLoading}
            onApprovalModeChange={(mode) =>
              executionSettingsMutation.mutate(approvalSettingsForMode(mode))
            }
            onPermissionProfileChange={(permissionProfileId, approvalMode) =>
              executionSettingsMutation.mutate({
                permissionProfileId,
                ...approvalSettingsForMode(approvalMode),
              })
            }
          />
        ) : activeSection === "notifications" ? (
          <NotificationsPreferencesPanel
            disableError={disableNotificationsMutation.error}
            disableSuccess={disableNotificationsMutation.isSuccess}
            disabling={disableNotificationsMutation.isPending}
            enableError={enableNotificationsMutation.error}
            enableSuccess={enableNotificationsMutation.isSuccess && enableNotificationsMutation.data === "granted"}
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

type ExecutionApprovalMode = "askMe" | "autoReview";
type ExecutionApprovalSelection = ExecutionApprovalMode | "requiresChoice";

function ExecutionPreferencesPanel({
  profiles,
  profilesError,
  profilesLoading,
  saving,
  saveError,
  settings,
  settingsError,
  settingsLoading,
  onApprovalModeChange,
  onPermissionProfileChange,
}: {
  profiles?: Awaited<ReturnType<typeof listPermissionProfiles>>;
  profilesError: Error | null;
  profilesLoading: boolean;
  saving: boolean;
  saveError: Error | null;
  settings?: Awaited<ReturnType<typeof getComposerSettings>>;
  settingsError: Error | null;
  settingsLoading: boolean;
  onApprovalModeChange: (mode: ExecutionApprovalMode) => void;
  onPermissionProfileChange: (permissionProfileId: string | null, approvalMode: ExecutionApprovalMode) => void;
}) {
  const selectedPermissionProfileId = settings?.permissionProfileId ?? null;
  const approvalSelection = executionApprovalMode(settings?.approvalPolicy, settings?.approvalsReviewer);
  const normalizedApprovalMode = approvalSelection === "autoReview" ? "autoReview" : "askMe";
  const loading = settingsLoading || profilesLoading;
  const error = settingsError ?? profilesError ?? saveError;
  const permissionOptions = [
    { id: null, label: "Default", description: "Use the configured Codex default scope." },
    ...(profiles ?? []).map((profile) => ({
      id: profile.id,
      label: permissionProfileLabel(profile.id, profile.label),
      description: profile.description ?? permissionProfileDescription(profile.id),
    })),
  ];

  return (
    <Stack className="kodex-preferences-panel kodex-execution-panel" gap={14}>
      <Group justify="space-between" wrap="nowrap">
        <Text className="kodex-preferences-panel-title" fw={650}>
          Execution
        </Text>
        <Badge data-tone={saving ? "info" : "neutral"}>{saving ? "Saving" : "Defaults"}</Badge>
      </Group>

      {loading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text c="dimmed" size="sm">
            Loading execution defaults
          </Text>
        </Group>
      ) : null}
      {error ? (
        <Alert color="red" variant="light">
          {error.message}
        </Alert>
      ) : null}

      <Stack className="kodex-preferences-setting" gap={10}>
        <Box className="kodex-preferences-setting-header">
          <Text fw={600} id="kodex-permission-scope-label" size="sm">
            Permission scope
          </Text>
          <Text c="dimmed" size="xs">
            Default filesystem and sandbox access for future turns.
          </Text>
        </Box>
        <Box aria-labelledby="kodex-permission-scope-label" className="kodex-execution-option-list" role="radiogroup">
          {permissionOptions.map((option) => {
            const selected = option.id === selectedPermissionProfileId;
            return (
              <Button
                aria-checked={selected}
                className="kodex-execution-option"
                data-active={selected ? "true" : undefined}
                disabled={loading || saving}
                key={option.id ?? "default"}
                leftSection={selected ? <Check size={15} /> : <Shield size={15} />}
                onClick={() => onPermissionProfileChange(option.id, normalizedApprovalMode)}
                role="radio"
                type="button"
                variant={selected ? "light" : "subtle"}
              >
                <Box className="kodex-execution-option-copy">
                  <Text fw={600} size="sm">
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text c="dimmed" size="xs">
                      {option.description}
                    </Text>
                  ) : null}
                </Box>
              </Button>
            );
          })}
        </Box>
      </Stack>

      <Stack className="kodex-preferences-setting" gap={10}>
        <Box className="kodex-preferences-setting-header">
          <Text fw={600} id="kodex-approval-review-label" size="sm">
            Approval review
          </Text>
          <Text c="dimmed" size="xs">
            Default reviewer for sandbox escapes, network requests, and similar approval prompts.
          </Text>
        </Box>
        {approvalSelection === "requiresChoice" ? (
          <Alert color="yellow" variant="light">
            Choose a review mode to replace the previous no-approval default.
          </Alert>
        ) : null}
        <SegmentedControl
          aria-labelledby="kodex-approval-review-label"
          className="kodex-execution-review-control"
          data={[
            { label: "Ask me", value: "askMe" },
            { label: "Auto review", value: "autoReview" },
          ]}
          disabled={loading || saving}
          onChange={(value) => onApprovalModeChange(value as ExecutionApprovalMode)}
          value={approvalSelection === "requiresChoice" ? "" : approvalSelection}
        />
      </Stack>
    </Stack>
  );
}

function approvalSettingsForMode(mode: ExecutionApprovalMode) {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: mode === "autoReview" ? "auto_review" : "user",
  };
}

function executionApprovalMode(
  approvalPolicy?: string | null,
  approvalsReviewer?: string | null,
): ExecutionApprovalSelection {
  if (approvalPolicy && approvalPolicy !== "on-request") {
    return "requiresChoice";
  }
  return approvalsReviewer === "auto_review" || approvalsReviewer === "guardian_subagent" ? "autoReview" : "askMe";
}

function permissionProfileLabel(id: string, label?: string | null): string {
  const normalized = id.replace(/^:/, "");
  switch (normalized) {
    case "read-only":
      return "Read only";
    case "workspace":
      return "Workspace";
    case "danger-full-access":
      return "Danger full access";
    default:
      return label || id;
  }
}

function permissionProfileDescription(id: string): string | null {
  const normalized = id.replace(/^:/, "");
  switch (normalized) {
    case "read-only":
      return "Read files without writing changes.";
    case "workspace":
      return "Write inside the current workspace and ask before leaving it.";
    case "danger-full-access":
      return "Run without sandbox restrictions on this local machine.";
    default:
      return null;
  }
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
