import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";

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
                <Badge color="green" size="sm" variant="light">
                  Loaded
                </Badge>
              ) : null}
            </Group>
            <Text c="dimmed" size="xs">
              {server.runtime
                ? `${Object.keys(server.runtime.tools).length} tools · ${server.runtime.resources.length} resources · ${server.runtime.resourceTemplates.length} templates`
                : transportLabel(server.configured)}
            </Text>
          </Box>
        </Button>
      ))}
    </Stack>
  );
}
