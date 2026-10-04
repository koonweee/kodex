import { Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Server } from "lucide-react";
import { useMemo, useState } from "react";

import {
  GatewayRequestError, addMcpServer, listConfiguredMcpServers, listMcpServers,
  removeMcpServer, updateMcpServer, readMcpResource, reloadMcpServers,
  setMcpServerEnabled, startMcpOAuthLogin,
  type ConfiguredMcpServer, type McpResource, type McpServerInstallRequest,
  type McpServerUpdateRequest, type NativeConfigWriteTarget,
} from "../api/client";
import { refreshNativeConfig } from "../api/nativeConfigCache";
import { queryKeys } from "../api/queryKeys";
import { NativeConfigWriteFeedback } from "../preferences/NativeConfigWriteFeedback";
import { McpEditorModal } from "./McpEditorModal";
import { McpServerDetail } from "./McpServerDetail";
import { McpServerList } from "./McpServerList";
import { mergeMcpServers, type MergedMcpServer } from "./mcpTypes";

type EditorSession = { server?: ConfiguredMcpServer; writeTarget: NativeConfigWriteTarget; key: number };
type ConfigAction =
  | { kind: "add"; request: McpServerInstallRequest }
  | { kind: "edit"; server: string; request: McpServerUpdateRequest }
  | { kind: "toggle"; server: string; enabled: boolean; writeTarget: NativeConfigWriteTarget }
  | { kind: "remove"; server: string; writeTarget: NativeConfigWriteTarget };

export function McpPreferencesPanel() {
  const queryClient = useQueryClient();
  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<McpResource | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<{ server: string; writeTarget: NativeConfigWriteTarget } | null>(null);

  const serversQuery = useQuery({ queryFn: ({ signal }) => listMcpServers(signal), queryKey: queryKeys.mcpServers });
  const configuredQuery = useQuery({ queryFn: ({ signal }) => listConfiguredMcpServers(signal), queryKey: queryKeys.mcpConfiguredServers });
  const mergedServers = useMemo(() => mergeMcpServers(configuredQuery.data?.servers ?? [], serversQuery.data?.servers ?? []), [configuredQuery.data, serversQuery.data]);
  const selectedServer = mergedServers.find((server) => server.name === selectedServerName) ?? mergedServers[0] ?? null;
  const writeTarget = configuredQuery.data?.writeTarget;
  const canReview = Boolean(writeTarget) && !configuredQuery.isFetching && !configuredQuery.error && (!editor?.server || Boolean(configuredQuery.data?.servers.some((server) => server.name === editor.server?.name)));

  const reloadMutation = useMutation({
    mutationFn: reloadMcpServers,
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.mcpServers });
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
    },
  });
  const mutation = useMutation({
    mutationFn: (action: ConfigAction) => {
      switch (action.kind) {
        case "add": return addMcpServer(action.request);
        case "edit": return updateMcpServer(action.server, action.request);
        case "toggle": return setMcpServerEnabled(action.server, action.enabled, action.writeTarget);
        case "remove": return removeMcpServer(action.server, action.writeTarget);
      }
    },
    onSuccess: async () => {
      setEditor(null);
      setRemoveConfirm(null);
      setNeedsReview(false);
      await refreshNativeConfig(queryClient);
    },
    onError: async (error) => {
      if (error instanceof GatewayRequestError && error.code === "config_version_conflict") {
        setNeedsReview(true);
        await refreshNativeConfig(queryClient);
      }
    },
  });
  const oauthMutation = useMutation({ mutationFn: startMcpOAuthLogin, onSuccess: (response) => setOauthUrl(response.authorizationUrl) });
  const resourceQuery = useQuery({
    enabled: Boolean(selectedServer?.runtime && selectedResource),
    queryFn: () => readMcpResource(selectedServer!.name, selectedResource!.uri),
    queryKey: queryKeys.mcpResource(selectedServer?.name ?? "none", selectedResource?.uri ?? "none"),
  });
  const writesDisabled = !writeTarget || Boolean(configuredQuery.error) || mutation.isPending || needsReview;

  function selectServer(server: MergedMcpServer) {
    setSelectedServerName(server.name);
    setSelectedResource(null);
    setOauthUrl(null);
    setRemoveConfirm(null);
    oauthMutation.reset();
  }
  function openEditor(server?: ConfiguredMcpServer) {
    if (!writeTarget || writesDisabled) return;
    mutation.reset();
    setRemoveConfirm(null);
    setEditor({ server, writeTarget, key: 0 });
  }
  function reviewLatest() {
    if (!writeTarget || !canReview) return;
    if (editor) setEditor({
      server: editor.server ? configuredQuery.data?.servers.find((server) => server.name === editor.server?.name) : undefined,
      writeTarget, key: editor.key + 1,
    });
    setRemoveConfirm(null);
    setNeedsReview(false);
    mutation.reset();
  }
  function toggle(enabled: boolean) {
    if (writeTarget && selectedServer && !writesDisabled) mutation.mutate({ kind: "toggle", enabled, server: selectedServer.name, writeTarget });
  }
  function remove() {
    if (!selectedServer || !writeTarget || writesDisabled) return;
    if (removeConfirm?.server === selectedServer.name) mutation.mutate({ kind: "remove", ...removeConfirm });
    else setRemoveConfirm({ server: selectedServer.name, writeTarget });
  }

  return <Stack className="kodex-preferences-panel kodex-mcp-panel" gap={14}>
    <Group justify="space-between" wrap="nowrap">
      <Text className="kodex-preferences-panel-title" fw={650}>MCP</Text>
      <Group gap={6} wrap="nowrap">
        <Button aria-label="Reload MCP servers" disabled={reloadMutation.isPending} leftSection={<RotateCw size={15} />} loading={reloadMutation.isPending} onClick={() => reloadMutation.mutate()} size="xs" variant="subtle">Reload</Button>
        <Button disabled={writesDisabled} onClick={() => openEditor()} size="xs" variant="light">Add server</Button>
      </Group>
    </Group>
    {serversQuery.isLoading || configuredQuery.isLoading ? <Group gap={8}><Loader size={14} /><Text c="dimmed" size="xs">Loading MCP servers</Text></Group> : null}
    {serversQuery.error ? <Alert color="red" variant="light">{serversQuery.error.message}</Alert> : null}
    {configuredQuery.error ? <Alert color="red" variant="light">{configuredQuery.error.message}</Alert> : null}
    {reloadMutation.error ? <Alert color="red" variant="light">{reloadMutation.error.message}</Alert> : null}
    {reloadMutation.data ? <Alert color={reloadMutation.data.error ? "yellow" : "blue"} variant="light">{reloadMutation.data.error ?? (reloadMutation.data.queued ? "MCP reload requested. Server status updates determine availability." : "MCP reload was not requested.")}</Alert> : null}
    {mutation.data?.write ? <NativeConfigWriteFeedback write={mutation.data.write} reload={mutation.data.reload} notificationError={mutation.data.notificationError} /> : null}
    {mutation.error && !editor && !needsReview ? <Alert color="red" variant="light">{mutation.error.message}</Alert> : null}
    {needsReview && !editor ? <Alert color="yellow" variant="light"><Stack gap={8}>
      <Text size="sm">Native configuration changed elsewhere. Review the current values before choosing again.</Text>
      <Button disabled={!canReview} onClick={reviewLatest} size="xs" variant="light">Review latest configuration</Button>
    </Stack></Alert> : null}
    {configuredQuery.data && !writeTarget ? <Text c="dimmed" size="sm">This native configuration has no editable user target.</Text> : null}
    {removeConfirm ? <Text c="dimmed" size="xs">Remove this server from {removeConfirm.writeTarget.filePath}. An inherited server may still appear.</Text> : null}
    {!serversQuery.isLoading && !configuredQuery.isLoading && !serversQuery.error && !configuredQuery.error && mergedServers.length === 0 ? <Box className="kodex-empty">
      <Box aria-hidden="true" className="kodex-empty-icon"><Server size={18} /></Box>
      <Text fw={650} size="sm">No MCP servers configured</Text>
      <Text c="dimmed" size="xs">Runtime inventory appears here after Codex loads MCP servers.</Text>
    </Box> : null}
    {mergedServers.length ? <Box className="kodex-mcp-layout">
      <McpServerList onSelect={selectServer} selectedName={selectedServer?.name} servers={mergedServers} />
      {selectedServer ? <McpServerDetail
        configured={selectedServer.configured} writesDisabled={writesDisabled}
        oauthError={oauthMutation.error?.message} oauthLoading={oauthMutation.isPending} oauthUrl={oauthUrl}
        onDisable={() => toggle(false)} onEnable={() => toggle(true)} onLogin={() => oauthMutation.mutate(selectedServer.name)}
        onReadResource={setSelectedResource} onRemove={remove} onEdit={() => openEditor(selectedServer.configured)}
        resource={selectedResource} resourceError={resourceQuery.error?.message} resourceLoading={resourceQuery.isFetching} resourceResponse={resourceQuery.data}
        removeConfirming={removeConfirm?.server === selectedServer.name} server={selectedServer.runtime} serverName={selectedServer.name}
      /> : null}
    </Box> : null}
    {editor ? <McpEditorModal key={editor.key}
      existingServer={editor.server} writeTarget={editor.writeTarget} onClose={() => setEditor(null)}
      onCreate={(request) => mutation.mutate({ kind: "add", request })}
      onUpdate={(request) => { if (editor.server) mutation.mutate({ kind: "edit", server: editor.server.name, request }); }}
      pending={mutation.isPending} error={needsReview ? undefined : mutation.error?.message} needsReview={needsReview} canReview={canReview} onReview={reviewLatest}
    /> : null}
  </Stack>;
}
