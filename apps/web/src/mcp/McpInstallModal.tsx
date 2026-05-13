import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConfiguredMcpServer, McpServerInstallRequest } from "../api/client";
import { StoredSecretRows, type SecretAction } from "./McpSecretRows";

type McpInstallModalProps = {
  existingServer?: ConfiguredMcpServer;
  initialName?: string;
  mode: "add" | "replace";
  opened: boolean;
  onClose: () => void;
  onSubmit: (request: McpServerInstallRequest) => void;
  pending?: boolean;
};

export function McpInstallModal({
  existingServer,
  initialName = "",
  mode,
  opened,
  onClose,
  onSubmit,
  pending = false,
}: McpInstallModalProps) {
  const [name, setName] = useState(initialName);
  const [transport, setTransport] = useState<"streamableHttp" | "stdio">("streamableHttp");
  const [url, setUrl] = useState("");
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = useState("");
  const [httpHeaders, setHttpHeaders] = useState("");
  const [envHttpHeaders, setEnvHttpHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [envVars, setEnvVars] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [required, setRequired] = useState(false);
  const [startupTimeoutSec, setStartupTimeoutSec] = useState("");
  const [toolTimeoutSec, setToolTimeoutSec] = useState("");
  const [envSecretActions, setEnvSecretActions] = useState<Record<string, SecretAction>>({});
  const [httpHeaderSecretActions, setHttpHeaderSecretActions] = useState<Record<string, SecretAction>>({});
  const [confirmReplaceSecrets, setConfirmReplaceSecrets] = useState(false);
  const [confirmLocalCommand, setConfirmLocalCommand] = useState(false);

  useEffect(() => {
    if (opened) {
      setName(initialName);
      const existingTransport = existingServer?.transport;
      setTransport(existingTransport?.type === "stdio" ? "stdio" : "streamableHttp");
      setUrl(existingTransport?.type === "streamableHttp" ? existingTransport.url : "");
      setBearerTokenEnvVar(existingTransport?.type === "streamableHttp" ? existingTransport.bearerTokenEnvVar ?? "" : "");
      setHttpHeaders("");
      setEnvHttpHeaders(existingTransport?.type === "streamableHttp" ? formatKeyValueLines(existingTransport.envHttpHeaders ?? {}) : "");
      setCommand(existingTransport?.type === "stdio" ? existingTransport.command : "");
      setArgs(existingTransport?.type === "stdio" ? (existingTransport.args ?? []).join(" ") : "");
      setCwd(existingTransport?.type === "stdio" ? existingTransport.cwd ?? "" : "");
      setEnv("");
      setEnvVars(existingTransport?.type === "stdio" ? (existingTransport.envVars ?? []).join("\n") : "");
      setEnabled(existingServer?.enabled ?? true);
      setRequired(existingServer?.required ?? false);
      setStartupTimeoutSec(existingServer?.startupTimeoutSec?.toString() ?? "");
      setToolTimeoutSec(existingServer?.toolTimeoutSec?.toString() ?? "");
      setEnvSecretActions(existingTransport?.type === "stdio" ? initialSecretActions(Object.keys(existingTransport.env ?? {})) : {});
      setHttpHeaderSecretActions(existingTransport?.type === "streamableHttp" ? initialSecretActions(Object.keys(existingTransport.httpHeaders ?? {})) : {});
      setConfirmReplaceSecrets(false);
      setConfirmLocalCommand(false);
    }
  }, [existingServer, initialName, opened]);

  function submit() {
    if (mode === "replace" && existingServer?.hasStoredSecrets && !confirmReplaceSecrets) {
      setConfirmReplaceSecrets(true);
      return;
    }
    if (transport === "stdio" && !confirmLocalCommand) {
      setConfirmLocalCommand(true);
      return;
    }
    const startupTimeout = optionalNumber(startupTimeoutSec);
    const toolTimeout = optionalNumber(toolTimeoutSec);
    const request: McpServerInstallRequest = {
      enabled,
      name: name.trim(),
      ...(required ? { required } : {}),
      ...(startupTimeout === undefined ? {} : { startupTimeoutSec: startupTimeout }),
      ...(toolTimeout === undefined ? {} : { toolTimeoutSec: toolTimeout }),
      transport:
        transport === "stdio"
          ? buildStdioTransport(command, args, cwd, env, envVars, envSecretActions)
          : buildHttpTransport(url, bearerTokenEnvVar, httpHeaders, envHttpHeaders, httpHeaderSecretActions),
    };
    onSubmit(request);
  }

  const needsConfirmation = (mode === "replace" && existingServer?.hasStoredSecrets && !confirmReplaceSecrets)
    || (transport === "stdio" && !confirmLocalCommand);

  return (
    <Modal centered onClose={onClose} opened={opened} size={560} title={mode === "add" ? "Add MCP server" : "Replace MCP server"}>
      <Stack gap={12}>
        <TextInput disabled={mode === "replace"} label="Name" onChange={(event) => setName(event.currentTarget.value)} value={name} />
        <SegmentedControl
          aria-label="MCP transport"
          data={[
            { label: "HTTP", value: "streamableHttp" },
            { label: "Local command", value: "stdio" },
          ]}
          onChange={(value) => setTransport(value as "streamableHttp" | "stdio")}
          value={transport}
        />

        {transport === "streamableHttp" ? (
          <Stack gap={10}>
            <TextInput label="URL" onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://mcp.example.com" value={url} />
            <TextInput
              label="Bearer token environment variable"
              onChange={(event) => setBearerTokenEnvVar(event.currentTarget.value)}
              placeholder="GITHUB_TOKEN"
              value={bearerTokenEnvVar}
            />
            <Textarea
              aria-label="HTTP headers"
              autosize
              label={<SecretLabel label="HTTP headers" />}
              minRows={2}
              onChange={(event) => setHttpHeaders(event.currentTarget.value)}
              placeholder={"Authorization=Bearer ...\nX-API-Key=..."}
              value={httpHeaders}
            />
            <StoredSecretRows actions={httpHeaderSecretActions} label="Stored HTTP headers" onChange={setHttpHeaderSecretActions} />
            <Textarea
              autosize
              label="Header environment variables"
              minRows={2}
              onChange={(event) => setEnvHttpHeaders(event.currentTarget.value)}
              placeholder={"Authorization=GITHUB_TOKEN\nX-API-Key=API_KEY"}
              value={envHttpHeaders}
            />
          </Stack>
        ) : (
          <Stack gap={10}>
            <TextInput aria-label="Command" label={<LocalCommandLabel />} onChange={(event) => setCommand(event.currentTarget.value)} placeholder="npx" value={command} />
            <TextInput onChange={(event) => setArgs(event.currentTarget.value)} label="Arguments" placeholder="-y @modelcontextprotocol/server-filesystem" value={args} />
            <TextInput label="Working directory" onChange={(event) => setCwd(event.currentTarget.value)} placeholder="/Users/me/project" value={cwd} />
            <Textarea
              aria-label="Environment values"
              autosize
              label={<SecretLabel label="Environment values" />}
              minRows={2}
              onChange={(event) => setEnv(event.currentTarget.value)}
              placeholder={"GITHUB_TOKEN=...\nAPI_KEY=..."}
              value={env}
            />
            <StoredSecretRows actions={envSecretActions} label="Stored environment values" onChange={setEnvSecretActions} />
            <Textarea
              autosize
              label="Environment variable names"
              minRows={2}
              onChange={(event) => setEnvVars(event.currentTarget.value)}
              placeholder={"GITHUB_TOKEN\nAPI_KEY"}
              value={envVars}
            />
          </Stack>
        )}

        <Switch checked={enabled} label="Enabled" onChange={(event) => setEnabled(event.currentTarget.checked)} />
        <Switch checked={required} label="Required" onChange={(event) => setRequired(event.currentTarget.checked)} />
        <Group grow>
          <TextInput
            label="Startup timeout seconds"
            onChange={(event) => setStartupTimeoutSec(event.currentTarget.value)}
            placeholder="10"
            value={startupTimeoutSec}
          />
          <TextInput
            label="Tool timeout seconds"
            onChange={(event) => setToolTimeoutSec(event.currentTarget.value)}
            placeholder="60"
            value={toolTimeoutSec}
          />
        </Group>

        {confirmReplaceSecrets ? (
          <Alert color="yellow" variant="light">
            Replacing this server writes exactly the submitted config. Existing stored env/header values may be replaced or cleared.
          </Alert>
        ) : null}
        {confirmLocalCommand ? (
          <Alert color="yellow" variant="light">
            Codex will run this command locally when loading the MCP server.
          </Alert>
        ) : null}

        <Group justify="flex-end">
          <Button onClick={onClose} size="xs" type="button" variant="subtle">
            Cancel
          </Button>
          <Button loading={pending} onClick={submit} size="xs" type="button">
            {needsConfirmation ? "Confirm" : mode === "add" ? "Add server" : "Replace server"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function SecretLabel({ label }: { label: string }) {
  return (
    <Group gap={5} wrap="nowrap">
      <Text size="sm">{label}</Text>
      <Tooltip label="Inline values are stored in local Codex config and masked on readback.">
        <AlertTriangle size={14} />
      </Tooltip>
    </Group>
  );
}

function LocalCommandLabel() {
  return (
    <Group gap={5} wrap="nowrap">
      <Text size="sm">Command</Text>
      <Tooltip label="Codex runs this command locally when loading the MCP server.">
        <AlertTriangle size={14} />
      </Tooltip>
    </Group>
  );
}

function buildStdioTransport(
  command: string,
  args: string,
  cwd: string,
  env: string,
  envVars: string,
  actions: Record<string, SecretAction>,
): McpServerInstallRequest["transport"] {
  const replacements = replacementValues(actions);
  const clearEnv = clearedNames(actions);
  const cwdValue = emptyToUndefined(cwd);
  const envVarList = splitList(envVars);
  return {
    args: splitArgs(args),
    ...(clearEnv.length ? { clearEnv } : {}),
    command: command.trim(),
    ...(cwdValue ? { cwd: cwdValue } : {}),
    env: { ...parseKeyValueLines(env), ...replacements },
    ...(envVarList.length ? { envVars: envVarList } : {}),
    type: "stdio",
  };
}

function buildHttpTransport(
  url: string,
  bearerTokenEnvVar: string,
  httpHeaders: string,
  envHttpHeaders: string,
  actions: Record<string, SecretAction>,
): McpServerInstallRequest["transport"] {
  const replacements = replacementValues(actions);
  const clearHttpHeaders = clearedNames(actions);
  const bearerEnv = emptyToUndefined(bearerTokenEnvVar);
  const envHeaderMap = parseKeyValueLines(envHttpHeaders);
  return {
    ...(bearerEnv ? { bearerTokenEnvVar: bearerEnv } : {}),
    ...(clearHttpHeaders.length ? { clearHttpHeaders } : {}),
    ...(Object.keys(envHeaderMap).length ? { envHttpHeaders: envHeaderMap } : {}),
    httpHeaders: { ...parseKeyValueLines(httpHeaders), ...replacements },
    type: "streamableHttp",
    url: url.trim(),
  };
}

function splitArgs(value: string): string[] {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function splitList(value: string): string[] {
  return value.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
}

function parseKeyValueLines(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1)];
      })
      .filter(([key]) => key.length > 0),
  );
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatKeyValueLines(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {}).map(([key, header]) => `${key}=${header}`).join("\n");
}

function initialSecretActions(keys: string[]): Record<string, SecretAction> {
  return Object.fromEntries(keys.map((key) => [key, { mode: "unchanged", value: "" } satisfies SecretAction]));
}

function replacementValues(actions: Record<string, SecretAction>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(actions)
      .filter(([, action]) => action.mode === "replace")
      .map(([key, action]) => [key, action.value]),
  );
}

function clearedNames(actions: Record<string, SecretAction>): string[] {
  return Object.entries(actions)
    .filter(([, action]) => action.mode === "clear")
    .map(([key]) => key);
}
