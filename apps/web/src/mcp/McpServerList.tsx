import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";

import type { McpServerStatus } from "../api/client";
import { authColor, authLabel, type MergedMcpServer, transportLabel } from "./mcpTypes";

type McpServerListProps = {
  onSelect: (server: MergedMcpServer) => void;
  selectedName?: string;
  servers: MergedMcpServer[];
};

export function McpServerList({ onSelect, selectedName, servers }: McpServerListProps) {
  return (
    <Stack className="kodex-mcp-server-list" gap={6}>
      {servers.map((server) => (
        <Button
          className="kodex-mcp-server-row"
          data-active={server.name === selectedName ? "true" : undefined}
          key={server.name}
          onClick={() => onSelect(server)}
          type="button"
          variant={server.name === selectedName ? "light" : "subtle"}
        >
          <Box className="kodex-mcp-server-row-copy">
            <Group className="kodex-mcp-server-row-title" gap={6} wrap="wrap">
              <Text className="kodex-mcp-server-name" fw={650} size="sm">
                {server.name}
              </Text>
              {server.runtime ? (
                <Badge color={authColor(server.runtime.authStatus)} size="sm" variant="light">
                  {authLabel(server.runtime.authStatus)}
                </Badge>
              ) : null}
              {server.configured ? (
                <Badge color="blue" size="sm" variant="light">
                  Configured
                </Badge>
              ) : null}
              {server.runtime ? (
                <Badge color={server.runtime.runtimeStatus === "connected" ? "green" : server.runtime.runtimeStatus === "failed" ? "red" : "gray"} size="sm" variant="light">
                  {runtimeLabel(server.runtime.runtimeStatus)}
                </Badge>
              ) : null}
            </Group>
            <Text c="dimmed" size="xs">
              {server.runtime
                ? `${server.runtime.toolsError ? "Tools unavailable" : `${Object.keys(server.runtime.tools).length} tools`} · ${server.runtime.resources.length} resources · ${server.runtime.resourceTemplates.length} templates`
                : transportLabel(server.configured)}
            </Text>
          </Box>
        </Button>
      ))}
    </Stack>
  );
}

function runtimeLabel(status: McpServerStatus["runtimeStatus"]): string {
  switch (status) {
    case "notStarted": return "Not started";
    case "starting": return "Starting";
    case "connected": return "Connected";
    case "authenticationRequired": return "Authentication required";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "disabled": return "Disabled";
    default: return "Status unavailable";
  }
}
