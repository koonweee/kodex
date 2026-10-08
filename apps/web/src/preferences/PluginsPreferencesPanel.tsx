import { Alert, Badge, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, RefreshCw } from "lucide-react";
import { getKodexControlPluginStatus, installKodexControlPlugin } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export function usePluginsPreferencesPanel(enabled: boolean) {
  const queryClient = useQueryClient();
  const pluginStatusQuery = useQuery({
    enabled,
    queryFn: getKodexControlPluginStatus,
    queryKey: queryKeys.kodexControlPlugin,
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
  return <KodexControlPluginPanel
    installError={installPluginMutation.error}
    installing={installPluginMutation.isPending}
    onInstall={() => installPluginMutation.mutate()}
    onRefresh={() => pluginStatusQuery.refetch()}
    status={pluginStatusQuery.data}
    statusError={pluginStatusQuery.error}
    statusLoading={pluginStatusQuery.isLoading}
  />;
}

function KodexControlPluginPanel({
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
