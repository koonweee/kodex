import { Alert, Badge, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
import { Bell, BellOff, Send } from "lucide-react";
import {
  deleteCurrentPushSubscription,
  getCurrentPushSubscriptionStatus,
  getNotificationStatus,
  sendTestNotification,
  upsertPushSubscription,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { requestKodexNotificationPermission } from "../notifications/browserNotifications";
import {
  browserPushNotificationsSupported,
  type BrowserPushNotificationState,
  type BrowserPushSubscriptionTransport,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
  loadBrowserPushNotificationState,
} from "../notifications/pushSubscriptions";

export type NotificationsPreferencesTransport = BrowserPushSubscriptionTransport & {
  status: typeof getNotificationStatus;
  test: typeof sendTestNotification;
  statusKey: readonly string[];
  currentKey: readonly string[];
  refillOnFocus?: boolean;
};
const defaultTransport: NotificationsPreferencesTransport = {
  current: getCurrentPushSubscriptionStatus,
  upsert: upsertPushSubscription,
  disable: deleteCurrentPushSubscription,
  status: getNotificationStatus,
  test: sendTestNotification,
  statusKey: queryKeys.notificationStatus,
  currentKey: ["notifications", "current-device"],
};

// Kept at modal/host lifetime so pending mutations survive section navigation.
export function useNotificationsPreferencesPanel(enabled: boolean, transport: NotificationsPreferencesTransport = defaultTransport) {
  const queryClient = useQueryClient();
  const { statusKey, currentKey } = transport;
  const notificationStatusQuery = useQuery({
    enabled,
    ...(transport.refillOnFocus ? { staleTime: 0 } : {}),
    queryFn: ({ signal }) => transport.status(signal),
    queryKey: statusKey,
  });
  const currentPushStateQuery = useQuery({
    enabled,
    ...(transport.refillOnFocus ? { staleTime: 0 } : {}),
    queryFn: ({ signal }) => loadBrowserPushNotificationState(signal, transport),
    queryKey: currentKey,
  });
  const enableNotificationsMutation = useMutation({
    mutationFn: async () => {
      const status = notificationStatusQuery.data ?? (await transport.status());
      if (!status.vapidPublicKey) {
        throw new Error("Notifications are not configured");
      }
      const permission = await requestKodexNotificationPermission();
      if (permission !== "granted") {
        return permission;
      }
      await enableBrowserPushNotifications(status.vapidPublicKey, transport);
      return permission;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statusKey }),
        queryClient.invalidateQueries({ queryKey: currentKey }),
      ]);
    },
  });
  const disableNotificationsMutation = useMutation({
    mutationFn: () => disableBrowserPushNotifications(transport),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: currentKey });
    },
  });
  const testNotificationMutation = useMutation({
    mutationFn: transport.test,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: currentKey });
    },
  });

  const refill = useEffectEvent(() => {
    if (enabled && document.visibilityState === "visible") {
      void notificationStatusQuery.refetch();
      void currentPushStateQuery.refetch();
    }
  });
  useEffect(() => {
    if (!transport.refillOnFocus) return;
    window.addEventListener("focus", refill);
    document.addEventListener("visibilitychange", refill);
    return () => {
      window.removeEventListener("focus", refill);
      document.removeEventListener("visibilitychange", refill);
    };
  }, [transport.refillOnFocus]);
  return (
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
