import { Alert, Badge, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { Package, RefreshCw } from "lucide-react";

import { getKodexControlPluginStatus } from "../api/client";
import { AnimatedNumericText } from "../ui/AnimatedNumericText";

export function PluginsPreferencesPanel({
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
              <AnimatedNumericText text={`${status.skills.length} skills · ${status.mcpServers.length} MCP servers`} />
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
