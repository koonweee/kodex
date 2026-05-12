import { Alert, Anchor, Badge, Box, Button, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText, KeyRound, RefreshCw, RotateCw, Server } from "lucide-react";
import { useMemo, useState } from "react";

import {
  listMcpServers,
  readMcpResource,
  reloadMcpServers,
  startMcpOAuthLogin,
  type McpResource,
  type McpServerStatus,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";

export function McpPreferencesPanel() {
  const queryClient = useQueryClient();
  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<McpResource | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const serversQuery = useQuery({
    queryFn: listMcpServers,
    queryKey: queryKeys.mcpServers,
  });
  const servers = serversQuery.data?.servers ?? [];
  const selectedServer = useMemo(
    () => servers.find((server) => server.name === selectedServerName) ?? servers[0] ?? null,
    [selectedServerName, servers],
  );

  const reloadMutation = useMutation({
    mutationFn: reloadMcpServers,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
    },
  });
  const oauthMutation = useMutation({
    mutationFn: startMcpOAuthLogin,
    onSuccess: (response) => setOauthUrl(response.authorizationUrl),
  });
  const resourceQuery = useQuery({
    enabled: Boolean(selectedServer && selectedResource),
    queryFn: () => readMcpResource(selectedServer!.name, selectedResource!.uri),
    queryKey:
      selectedServer && selectedResource
        ? queryKeys.mcpResource(selectedServer.name, selectedResource.uri)
        : queryKeys.mcpResource("none", "none"),
  });

  function selectServer(server: McpServerStatus) {
    setSelectedServerName(server.name);
    setSelectedResource(null);
    setOauthUrl(null);
    oauthMutation.reset();
  }

  return (
    <Stack className="kodex-preferences-panel kodex-mcp-panel" gap={14}>
      <Group justify="space-between" wrap="nowrap">
        <Text className="kodex-preferences-panel-title" fw={650}>
          MCP
        </Text>
        <Group gap={6} wrap="nowrap">
          <Button
            aria-label="Reload MCP servers"
            disabled={reloadMutation.isPending}
            leftSection={<RotateCw size={15} />}
            loading={reloadMutation.isPending}
            onClick={() => reloadMutation.mutate()}
            size="xs"
            type="button"
            variant="subtle"
          >
            Reload
          </Button>
          <Button
            aria-label="Refresh MCP servers"
            disabled={serversQuery.isFetching}
            leftSection={<RefreshCw size={15} />}
            onClick={() => serversQuery.refetch()}
            size="xs"
            type="button"
            variant="subtle"
          >
            Refresh
          </Button>
        </Group>
      </Group>

      {serversQuery.isLoading ? (
        <Group gap={8}>
          <Loader size={14} />
          <Text c="dimmed" size="xs">
            Loading MCP servers
          </Text>
        </Group>
      ) : null}

      {serversQuery.error ? (
        <Alert color="red" variant="light">
          {serversQuery.error.message}
        </Alert>
      ) : null}
      {reloadMutation.error ? (
        <Alert color="red" variant="light">
          {reloadMutation.error.message}
        </Alert>
      ) : null}

      {!serversQuery.isLoading && !serversQuery.error && servers.length === 0 ? (
        <Box className="kodex-empty">
          <Box aria-hidden="true" className="kodex-empty-icon">
            <Server size={18} />
          </Box>
          <Text fw={650} size="sm">
            No MCP servers configured
          </Text>
          <Text c="dimmed" size="xs">
            Runtime inventory appears here after Codex loads MCP servers.
          </Text>
        </Box>
      ) : null}

      {servers.length > 0 ? (
        <Box className="kodex-mcp-layout">
          <Stack className="kodex-mcp-server-list" gap={6}>
            {servers.map((server) => (
              <Button
                className="kodex-mcp-server-row"
                data-active={server.name === selectedServer?.name ? "true" : undefined}
                key={server.name}
                onClick={() => selectServer(server)}
                type="button"
                variant={server.name === selectedServer?.name ? "light" : "subtle"}
              >
                <Box className="kodex-mcp-server-row-copy">
                  <Group gap={8} wrap="wrap">
                    <Text fw={650} size="sm">
                      {server.name}
                    </Text>
                    <Badge color={authColor(server.authStatus)} size="sm" variant="light">
                      {authLabel(server.authStatus)}
                    </Badge>
                  </Group>
                  <Text c="dimmed" size="xs">
                    {Object.keys(server.tools).length} tools · {server.resources.length} resources ·{" "}
                    {server.resourceTemplates.length} templates
                  </Text>
                </Box>
              </Button>
            ))}
          </Stack>

          {selectedServer ? (
            <McpServerDetail
              oauthError={oauthMutation.error?.message}
              oauthLoading={oauthMutation.isPending}
              oauthUrl={oauthUrl}
              onLogin={() => oauthMutation.mutate(selectedServer.name)}
              onReadResource={setSelectedResource}
              resource={selectedResource}
              resourceError={resourceQuery.error?.message}
              resourceLoading={resourceQuery.isFetching}
              resourceResponse={resourceQuery.data}
              server={selectedServer}
            />
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
}

function McpServerDetail({
  oauthError,
  oauthLoading,
  oauthUrl,
  onLogin,
  onReadResource,
  resource,
  resourceError,
  resourceLoading,
  resourceResponse,
  server,
}: {
  oauthError?: string;
  oauthLoading: boolean;
  oauthUrl: string | null;
  onLogin: () => void;
  onReadResource: (resource: McpResource) => void;
  resource: McpResource | null;
  resourceError?: string;
  resourceLoading: boolean;
  resourceResponse?: Awaited<ReturnType<typeof readMcpResource>>;
  server: McpServerStatus;
}) {
  const toolNames = Object.keys(server.tools).sort();
  return (
    <Stack className="kodex-mcp-detail" gap={12}>
      <Group justify="space-between" wrap="wrap">
        <Box>
          <Text fw={650} size="sm">
            {server.name}
          </Text>
          <Text c="dimmed" size="xs">
            {authLabel(server.authStatus)}
          </Text>
        </Box>
        {server.authStatus === "notLoggedIn" || server.authStatus === "oAuth" ? (
          <Button
            leftSection={<KeyRound size={15} />}
            loading={oauthLoading}
            onClick={onLogin}
            size="xs"
            type="button"
            variant="light"
          >
            Log in
          </Button>
        ) : null}
      </Group>

      {oauthError ? (
        <Alert color="red" variant="light">
          {oauthError}
        </Alert>
      ) : null}
      {oauthUrl ? (
        <Alert color="blue" variant="light">
          <Group gap={8} justify="space-between" wrap="nowrap">
            <Text size="sm">Authorization is ready.</Text>
            <Anchor href={oauthUrl} rel="noreferrer" target="_blank">
              <Group gap={4} wrap="nowrap">
                <Text size="sm">Open login</Text>
                <ExternalLink size={14} />
              </Group>
            </Anchor>
          </Group>
        </Alert>
      ) : null}

      <Box>
        <Text fw={650} size="xs">
          Tools
        </Text>
        {toolNames.length ? (
          <Text c="dimmed" size="xs">
            {toolNames.join(", ")}
          </Text>
        ) : (
          <Text c="dimmed" size="xs">
            No tools reported
          </Text>
        )}
      </Box>

      <Box>
        <Text fw={650} size="xs">
          Resources
        </Text>
        {server.resources.length ? (
          <Stack gap={6} mt={6}>
            {server.resources.map((item) => (
              <Button
                className="kodex-mcp-resource-row"
                key={item.uri}
                leftSection={<FileText size={14} />}
                onClick={() => onReadResource(item)}
                size="xs"
                type="button"
                variant={resource?.uri === item.uri ? "light" : "subtle"}
              >
                {item.title ?? item.name} ({item.uri})
              </Button>
            ))}
          </Stack>
        ) : (
          <Text c="dimmed" size="xs">
            No concrete resources reported
          </Text>
        )}
      </Box>

      <Box>
        <Text fw={650} size="xs">
          Resource templates
        </Text>
        {server.resourceTemplates.length ? (
          <Text c="dimmed" size="xs">
            {server.resourceTemplates.map((template) => template.title ?? template.name).join(", ")}
          </Text>
        ) : (
          <Text c="dimmed" size="xs">
            No templates reported
          </Text>
        )}
      </Box>

      {resource ? (
        <Box className="kodex-mcp-resource-preview">
          <Text fw={650} size="xs">
            {resource.title ?? resource.name}
          </Text>
          <Text c="dimmed" size="xs">
            {resource.uri}
          </Text>
          {resourceLoading ? (
            <Group gap={8} mt={8}>
              <Loader size={14} />
              <Text c="dimmed" size="xs">
                Reading resource
              </Text>
            </Group>
          ) : null}
          {resourceError ? (
            <Alert color="red" mt={8} variant="light">
              {resourceError}
            </Alert>
          ) : null}
          {resourceResponse ? (
            <ScrollArea.Autosize mah={220} mt={8} type="auto">
              <pre className="kodex-mcp-resource-content">{formatResourceContents(resourceResponse.contents)}</pre>
            </ScrollArea.Autosize>
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
}

function authLabel(status: McpServerStatus["authStatus"]): string {
  switch (status) {
    case "bearerToken":
      return "Bearer token";
    case "notLoggedIn":
      return "Not logged in";
    case "oAuth":
      return "OAuth";
    case "unsupported":
      return "Unsupported";
    default:
      return status;
  }
}

function authColor(status: McpServerStatus["authStatus"]): string {
  switch (status) {
    case "notLoggedIn":
      return "yellow";
    case "oAuth":
    case "bearerToken":
      return "green";
    default:
      return "gray";
  }
}

function formatResourceContents(contents: unknown[]): string {
  return contents
    .map((content) => {
      if (isTextContent(content)) {
        return content.text;
      }
      if (isBlobContent(content)) {
        return formatBlobContent(content);
      }
      return JSON.stringify(content, null, 2);
    })
    .join("\n\n");
}

function isTextContent(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";
}

function isBlobContent(value: unknown): value is { blob: string; mimeType?: string | null; uri?: string } {
  return typeof value === "object" && value !== null && "blob" in value && typeof value.blob === "string";
}

function formatBlobContent(content: { blob: string; mimeType?: string | null; uri?: string }) {
  return [
    "Unsupported binary resource",
    content.uri ? `URI: ${content.uri}` : null,
    content.mimeType ? `MIME type: ${content.mimeType}` : null,
    `Encoded payload length: ${content.blob.length} characters`,
  ]
    .filter(Boolean)
    .join("\n");
}
