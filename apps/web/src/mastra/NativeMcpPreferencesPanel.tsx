import { Alert, Anchor, Badge, Box, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, KeyRound, RotateCw, Server } from 'lucide-react';
import { useCallback, useState } from 'react';
import { mastraClient, type ChatClient } from './client';
import { useNativeSnapshots } from './useNativeSnapshots';
import { useNativeMcpAuthentication } from './useNativeMcpAuthentication';

type Inventory = Awaited<ReturnType<ChatClient['nativeMcpWatch']>> extends AsyncIterable<infer T> ? T : never;
type Runtime = Inventory['rows'][number];
type NativeServer = Runtime['servers'][number];
type ServerAction =
  | { kind: 'enabled'; input: Parameters<ChatClient['nativeMcpSetServerEnabled']>[0] }
  | { kind: 'inherit'; input: Parameters<ChatClient['nativeMcpInheritServer']>[0] };
const runtimeLabel = (runtime: Runtime) => `${runtime.projectName ?? 'Standalone'} · ${runtime.cwd}`;
function serverLabel(server: NativeServer) {
  if (server.disabled) return 'Disabled';
  if (server.authenticating) return 'Authenticating';
  if (server.connecting) return 'Connecting';
  if (server.connected) return 'Connected';
  if (server.cancelled) return 'Authentication cancelled';
  if (server.needsAuth) return 'Authentication required';
  return server.error ? 'Failed' : 'Not connected';
}
function ServerBadge({ server }: { server: NativeServer }) {
  return <Badge size="sm" variant="light" data-tone={server.disabled ? 'neutral' : server.connected ? 'success' : server.needsAuth ? 'warning' : server.error ? 'danger' : 'info'}>{serverLabel(server)}</Badge>;
}

function OperationErrors({ results, rows }: { results?: Awaited<ReturnType<ChatClient['nativeMcpReload']>>; rows: Runtime[] }) {
  return results?.filter(result => result.error).map(result => {
    const failedRuntime = rows.find(row => row.bindingId === result.bindingId);
    return <Alert key={result.bindingId} color="red" variant="light">{failedRuntime ? runtimeLabel(failedRuntime) : result.bindingId}: {result.error}</Alert>;
  });
}

export function NativeMcpPreferencesPanel() {
  const watch = useCallback((signal: AbortSignal) => mastraClient.nativeMcpWatch(undefined, { signal }), []);
  const view = useNativeSnapshots<Inventory>('native-mcp', watch);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [serverName, setServerName] = useState<string | null>(null);
  const rows = view.snapshot?.rows ?? [];
  const runtime = rows.find(row => row.bindingId === bindingId) ?? rows[0];
  const server = runtime?.servers.find(row => row.name === serverName) ?? runtime?.servers[0];
  const authentication = useNativeMcpAuthentication(runtime?.bindingId ?? null, server, view.snapshot, view.retry);
  const reload = useMutation({ mutationFn: () => mastraClient.nativeMcpReload({}), onSuccess: () => view.retry() });
  const update = useMutation({
    mutationFn: (action: ServerAction) => action.kind === 'enabled'
      ? mastraClient.nativeMcpSetServerEnabled(action.input) : mastraClient.nativeMcpInheritServer(action.input),
    onSuccess: () => view.retry(),
  });
  const selectedUpdate = Boolean(runtime && server && update.variables?.input.bindingId === runtime.bindingId && update.variables.input.server === server.name);
  const updatePending = selectedUpdate && update.isPending;
  const controlsDisabled = updatePending || runtime?.phase === 'initializing' || runtime?.phase === 'reloading';
  const loading = !view.snapshot && !view.error;
  const phaseLabel = runtime ? ({ disabled: 'Disabled', initializing: 'Initializing', reloading: 'Reloading', ready: 'Ready', failed: 'Failed' } as const)[runtime.phase] : null;

  return <Stack className="kodex-preferences-panel kodex-mcp-panel" gap={14}>
    <Group justify="space-between" wrap="nowrap">
      <Text className="kodex-preferences-panel-title" fw={650}>MCP</Text>
      <Button aria-label="Reload MCP servers" disabled={!rows.length || reload.isPending} leftSection={<RotateCw size={15} />}
        loading={reload.isPending} onClick={() => { authentication.clear(); reload.mutate(); }} size="xs" variant="subtle">Reload all</Button>
    </Group>
    {loading ? <Group gap={8}><Loader size={14} /><Text c="dimmed" size="xs">Loading MCP servers</Text></Group> : null}
    {view.error ? <Alert color="red" variant="light">{view.error}</Alert> : null}
    {reload.error ? <Alert color="red" variant="light">{reload.error.message}</Alert> : null}
    <OperationErrors results={reload.data} rows={rows} />
    {!loading && !view.error && !rows.length ? <Text c="dimmed" size="sm">No MCP runtimes available</Text> : null}
    {runtime ? <>
      <Select label="Runtime" data={rows.map(row => ({ value: row.bindingId, label: runtimeLabel(row) }))} value={runtime.bindingId}
        onChange={id => { authentication.clear(); setBindingId(id); setServerName(null); }} allowDeselect={false} />
      <Group justify="space-between" wrap="wrap">
        <Text c="dimmed" size="xs" className="kodex-mcp-wrapping-text">{runtime.cwd}</Text>
        <Badge data-tone={runtime.phase === 'failed' ? 'danger' : 'neutral'}>{phaseLabel}</Badge>
      </Group>
      {runtime.phase === 'disabled' ? <Text c="dimmed" size="sm">MCP is disabled for this runtime.</Text> : null}
      {runtime.phase === 'failed' ? <Text c="dimmed" size="sm">MCP discovery failed. Reload to try again.</Text> : null}
      {runtime.paths ? <Stack className="kodex-preferences-setting" gap={5}>
        <Text fw={650} size="xs">Server definitions</Text>
        <Text c="dimmed" size="xs">Edit server definitions in these files, then reload.</Text>
        <Text c="dimmed" size="xs" className="kodex-mcp-wrapping-text">{runtime.paths.project}</Text>
        <Text c="dimmed" size="xs" className="kodex-mcp-wrapping-text">{runtime.paths.global}</Text>
      </Stack> : null}
      {runtime.skipped.map(row => <Alert key={row.name} color="yellow" variant="light">{row.name}: {row.reason}</Alert>)}
      {runtime.phase === 'ready' && !runtime.servers.length && !runtime.skipped.length ? <Box className="kodex-empty">
        <Box aria-hidden="true" className="kodex-empty-icon"><Server size={18} /></Box>
        <Text fw={650} size="sm">No MCP servers configured</Text>
      </Box> : null}
      {runtime.servers.length ? <Box className="kodex-mcp-layout">
        <Stack className="kodex-mcp-server-list" gap={6}>
          {runtime.servers.map(row => <Button key={row.name} className="kodex-mcp-server-row" data-active={row.name === server?.name ? 'true' : undefined}
            onClick={() => { authentication.clear(); setServerName(row.name); }} type="button" variant={row.name === server?.name ? 'light' : 'subtle'}>
            <Box className="kodex-mcp-server-row-copy">
              <Group className="kodex-mcp-server-row-title" gap={6} wrap="wrap">
                <Text className="kodex-mcp-server-name" fw={650} size="sm">{row.name}</Text><ServerBadge server={row} />
              </Group>
              <Text c="dimmed" size="xs">{row.connected ? `${row.toolCount} tools` : 'Tools unavailable'} · {row.transport === 'stdio' ? 'Local command' : 'HTTP'}</Text>
            </Box>
          </Button>)}
        </Stack>
        {server ? <Stack className="kodex-mcp-detail" gap={12}>
          <Group justify="space-between" wrap="wrap">
            <Group gap={6}><Text fw={650} size="sm">{server.name}</Text><ServerBadge server={server} /></Group>
            <Group gap={6}>
              <Button disabled={controlsDisabled || Boolean(server.disabled && server.globalKillSwitch)} loading={updatePending && update.variables?.kind === 'enabled'}
                onClick={() => { authentication.clear(); update.mutate({ kind: 'enabled', input: { bindingId: runtime.bindingId, server: server.name, enabled: Boolean(server.disabled) } }); }}
                size="xs" type="button" variant="subtle">{server.disabled ? 'Enable' : 'Disable'}</Button>
              {server.projectOverride ? <Button disabled={controlsDisabled} loading={updatePending && update.variables?.kind === 'inherit'}
                onClick={() => { authentication.clear(); update.mutate({ kind: 'inherit', input: { bindingId: runtime.bindingId, server: server.name } }); }}
                size="xs" type="button" variant="subtle">Use global default</Button> : null}
              {server.authenticating ? <Button loading={authentication.cancelling} disabled={authentication.cancelling} onClick={authentication.cancel}
                size="xs" type="button" variant="subtle">Cancel authentication</Button> : server.transport === 'http' ? <Button leftSection={<KeyRound size={15} />}
                loading={authentication.starting} disabled={controlsDisabled || Boolean(server.disabled || server.globalKillSwitch || authentication.starting || authentication.authorizationUrl)}
                onClick={authentication.start} size="xs" type="button" variant="light">Log in</Button> : null}
            </Group>
          </Group>
          {server.globalKillSwitch ? <Text c="dimmed" size="xs">MCP is disabled globally; project settings cannot enable it.</Text> : null}
          {selectedUpdate && update.error ? <Alert color="red" variant="light">{update.error.message}</Alert> : null}
          {selectedUpdate ? <OperationErrors results={update.data} rows={rows} /> : null}
          {authentication.error ? <Alert color="red" variant="light">{authentication.error}</Alert> : null}
          {authentication.authorizationUrl ? <Alert color="blue" variant="light">
            <Group gap={8} justify="space-between" wrap="nowrap"><Text size="sm">Authorization is ready.</Text>
              <Anchor href={authentication.authorizationUrl} rel="noreferrer" target="_blank">
                <Group gap={4} wrap="nowrap"><Text size="sm">Open login</Text><ExternalLink size={14} /></Group>
              </Anchor>
            </Group>
          </Alert> : null}
          {server.error && !server.cancelled ? <Alert color="red" variant="light">{server.error}</Alert> : null}
          <Box><Text fw={650} size="xs">Tools</Text>
            <Text className="kodex-mcp-wrapping-text" c="dimmed" size="xs">
              {server.connected ? server.toolNames.length ? [...server.toolNames].sort().join(', ') : 'No tools reported' : 'Tools unavailable until connected'}
            </Text>
          </Box>
          {server.disabledScope ? <Text c="dimmed" size="xs">{server.disabledScope === 'global' ? 'Disabled by global settings' : 'Disabled for this project'}</Text> : null}
          <Text c="dimmed" size="xs">Resource browsing is not available in this panel.</Text>
        </Stack> : null}
      </Box> : null}
    </> : null}
  </Stack>;
}
