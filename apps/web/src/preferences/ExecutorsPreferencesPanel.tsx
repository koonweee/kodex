import { Alert, Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";

import { useFederatedCatalogContext } from "../federation/FederatedCatalogContext";

export function ExecutorsPreferencesPanel() {
  const federation = useFederatedCatalogContext();
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!federation) return null;

  async function run(label: string, operation: () => Promise<unknown>) {
    setPending(label);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Executor operation failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Stack className="kodex-preferences-panel" gap="md">
      <Group justify="space-between">
        <Text className="kodex-preferences-panel-title" fw={650}>Executors</Text>
        <Button loading={pending === "refresh"} size="xs" variant="default" onClick={() => void run("refresh", federation.refreshExecutors)}>
          Refresh
        </Button>
      </Group>
      <Text c="dimmed" size="sm">Each machine keeps its own Kodex service, Codex runtime, credentials, terminals, and jobs.</Text>
      {error ? <Alert color="red">{error}</Alert> : null}
      {federation.executors.map((executor) => (
        <Stack bd="1px solid var(--kodex-border-subtle)" gap="xs" key={executor.id} p="sm">
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text fw={600}>{executor.displayName}</Text>
              <Text c="dimmed" size="xs">{executor.baseUrl}</Text>
            </div>
            <Badge color={executor.status === "ready" ? "green" : executor.status === "incompatible" ? "red" : "gray"}>
              {executor.enabled ? executor.status : "disabled"}
            </Badge>
          </Group>
          <Text size="xs">Verified instance: {executor.instanceId}</Text>
          <Text size="xs">API {executor.apiVersion} · App-server schema {executor.appServerSchemaVersion}</Text>
          <Text size="xs">Last successful contact: {formatContact(executor.lastSeenAt)}</Text>
          {executor.lastError ? <Alert color="yellow">{executor.lastError}</Alert> : null}
          <Group gap="xs">
            <Button
              loading={pending === `probe:${executor.id}`}
              size="xs"
              variant="default"
              onClick={() => void run(`probe:${executor.id}`, () => federation.probeExecutor(executor.id))}
            >
              Check connection
            </Button>
            <Button
              loading={pending === `toggle:${executor.id}`}
              size="xs"
              variant="default"
              onClick={() => void run(`toggle:${executor.id}`, () => federation.updateExecutor(executor.id, { enabled: !executor.enabled }))}
            >
              {executor.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              color="red"
              loading={pending === `remove:${executor.id}`}
              size="xs"
              variant="subtle"
              onClick={() => void run(`remove:${executor.id}`, () => federation.removeExecutor(executor.id))}
            >
              Remove
            </Button>
          </Group>
        </Stack>
      ))}
      <Stack component="form" gap="xs" onSubmit={(event) => {
        event.preventDefault();
        void run("register", async () => {
          await federation.registerExecutor({ baseUrl: baseUrl.trim(), displayName: displayName.trim() });
          setBaseUrl("");
          setDisplayName("");
        });
      }}>
        <Text fw={600} size="sm">Add executor</Text>
        <TextInput label="Name" required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
        <TextInput label="Backend URL" placeholder="https://devbox.tailnet.ts.net" required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} />
        <Button disabled={!displayName.trim() || !baseUrl.trim()} loading={pending === "register"} type="submit">Add executor</Button>
      </Stack>
    </Stack>
  );
}

function formatContact(value: number): string {
  if (value <= 0) return "Never";
  return new Date(value * 1_000).toLocaleString();
}
