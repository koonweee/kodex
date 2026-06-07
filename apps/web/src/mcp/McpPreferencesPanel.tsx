import { Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Server } from "lucide-react";
import { useMemo, useState } from "react";

import {
  addMcpServer,
  listConfiguredMcpServers,
  listMcpServers,
  removeMcpServer,
  replaceMcpServer,
  readMcpResource,
  reloadMcpServers,
  setMcpServerEnabled,
  startMcpOAuthLogin,
  type McpConfigMutationResponse,
  type McpResource,
  type McpServerInstallRequest,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { McpInstallModal } from "./McpInstallModal";
import { McpServerDetail } from "./McpServerDetail";
import { McpServerList } from "./McpServerList";
import { mergeMcpServers, type MergedMcpServer } from "./mcpTypes";

export function McpPreferencesPanel() {
  const queryClient = useQueryClient();
  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<McpResource | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [installMode, setInstallMode] = useState<"add" | "replace" | null>(null);
  const [removeConfirmServer, setRemoveConfirmServer] = useState<string | null>(null);

  const serversQuery = useQuery({
    queryFn: listMcpServers,
    queryKey: queryKeys.mcpServers,
  });
  const configuredQuery = useQuery({
    queryFn: listConfiguredMcpServers,
    queryKey: queryKeys.mcpConfiguredServers,
  });
  const servers = serversQuery.data?.servers ?? [];
  const configuredServers = configuredQuery.data?.servers ?? [];
  const mergedServers = useMemo(() => mergeMcpServers(configuredServers, servers), [configuredServers, servers]);
  const selectedServer = useMemo(
    () => mergedServers.find((server) => server.name === selectedServerName) ?? mergedServers[0] ?? null,
    [selectedServerName, mergedServers],
  );

  const reloadMutation = useMutation({
    mutationFn: reloadMcpServers,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
    },
  });
  const onConfigMutationSuccess = async (_response: McpConfigMutationResponse) => {
    setInstallMode(null);
    setRemoveConfirmServer(null);
    await queryClient.invalidateQueries({ queryKey: queryKeys.mcpConfiguredServers });
    await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
  };
  const addMutation = useMutation({
    mutationFn: addMcpServer,
    onSuccess: onConfigMutationSuccess,
  });
  const replaceMutation = useMutation({
    mutationFn: (request: McpServerInstallRequest) => replaceMcpServer(selectedServer?.name ?? request.name, request),
    onSuccess: onConfigMutationSuccess,
  });
  const toggleMutation = useMutation({
    mutationFn: ({ enabled, server }: { enabled: boolean; server: string }) => setMcpServerEnabled(server, enabled),
    onSuccess: onConfigMutationSuccess,
  });
  const removeMutation = useMutation({
    mutationFn: removeMcpServer,
    onSuccess: onConfigMutationSuccess,
  });
  const oauthMutation = useMutation({
    mutationFn: startMcpOAuthLogin,
    onSuccess: (response) => setOauthUrl(response.authorizationUrl),
  });
  const resourceQuery = useQuery({
    enabled: Boolean(selectedServer?.runtime && selectedResource),
    queryFn: () => readMcpResource(selectedServer!.name, selectedResource!.uri),
    queryKey:
      selectedServer && selectedResource
        ? queryKeys.mcpResource(selectedServer.name, selectedResource.uri)
        : queryKeys.mcpResource("none", "none"),
  });

  function selectServer(server: MergedMcpServer) {
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
          <Button onClick={() => setInstallMode("add")} size="xs" type="button" variant="light">
            Add server
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
      {configuredQuery.error ? (
        <Alert color="red" variant="light">
          {configuredQuery.error.message}
        </Alert>
      ) : null}
      {addMutation.error || replaceMutation.error || toggleMutation.error || removeMutation.error ? (
        <Alert color="red" variant="light">
          {addMutation.error?.message ??
            replaceMutation.error?.message ??
            toggleMutation.error?.message ??
            removeMutation.error?.message}
        </Alert>
      ) : null}

      {!serversQuery.isLoading && !configuredQuery.isLoading && !serversQuery.error && mergedServers.length === 0 ? (
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

      {mergedServers.length > 0 ? (
        <Box className="kodex-mcp-layout">
          <McpServerList onSelect={selectServer} selectedName={selectedServer?.name} servers={mergedServers} />

          {selectedServer ? (
            <McpServerDetail
              configured={selectedServer.configured}
              oauthError={oauthMutation.error?.message}
              oauthLoading={oauthMutation.isPending}
              oauthUrl={oauthUrl}
              onDisable={() => toggleMutation.mutate({ enabled: false, server: selectedServer.name })}
              onEnable={() => toggleMutation.mutate({ enabled: true, server: selectedServer.name })}
              onLogin={() => oauthMutation.mutate(selectedServer.name)}
              onReadResource={setSelectedResource}
              onRemove={() => {
                if (removeConfirmServer === selectedServer.name) {
                  removeMutation.mutate(selectedServer.name);
                } else {
                  setRemoveConfirmServer(selectedServer.name);
                }
              }}
              onReplace={() => {
                setRemoveConfirmServer(null);
                setInstallMode("replace");
              }}
              resource={selectedResource}
              resourceError={resourceQuery.error?.message}
              resourceLoading={resourceQuery.isFetching}
              resourceResponse={resourceQuery.data}
              removeConfirming={removeConfirmServer === selectedServer.name}
              server={selectedServer.runtime}
              serverName={selectedServer.name}
            />
          ) : null}
        </Box>
      ) : null}

      <McpInstallModal
        existingServer={installMode === "replace" ? selectedServer?.configured : undefined}
        initialName={installMode === "replace" ? selectedServer?.name : ""}
        mode={installMode ?? "add"}
        onClose={() => setInstallMode(null)}
        onSubmit={(request) => {
          if (installMode === "replace") {
            replaceMutation.mutate(request);
          } else {
            addMutation.mutate(request);
          }
        }}
        opened={Boolean(installMode)}
        pending={addMutation.isPending || replaceMutation.isPending}
      />
    </Stack>
  );
}
