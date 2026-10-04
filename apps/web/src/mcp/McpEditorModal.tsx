import { Alert, Button, Group, Modal, SegmentedControl, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";

import type { ConfiguredMcpServer, McpServerInstallRequest, McpServerUpdateRequest, NativeConfigWriteTarget } from "../api/client";
import { StoredSecretRows } from "./McpSecretRows";
import { initialMcpForm, mcpCreateRequest, mcpFormError, mcpLeafEdits, type McpForm } from "./mcpForm";

export function McpEditorModal({ existingServer, writeTarget, onClose, onCreate, onUpdate, pending, error, needsReview, canReview, onReview }: {
  existingServer?: ConfiguredMcpServer;
  writeTarget: NativeConfigWriteTarget;
  onClose: () => void;
  onCreate: (request: McpServerInstallRequest) => void;
  onUpdate: (request: McpServerUpdateRequest) => void;
  pending: boolean;
  error?: string;
  needsReview: boolean;
  canReview: boolean;
  onReview: () => void;
}) {
  const [initial] = useState(() => initialMcpForm(existingServer));
  const [form, setForm] = useState(initial);
  const [validation, setValidation] = useState<string | null>(null);
  const [localCommandConfirmed, setLocalCommandConfirmed] = useState(false);
  const editing = Boolean(existingServer);
  const requiresCommandConfirmation = form.transport === "stdio" && (!editing || initial.transport !== "stdio" || form.command !== initial.command) && !localCommandConfirmed;
  const edits = editing ? mcpLeafEdits(form, initial) : [];
  function change<Key extends keyof McpForm>(key: Key, value: McpForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "command" || key === "transport") setLocalCommandConfirmed(false);
  }
  function submit() {
    const problem = mcpFormError(form);
    setValidation(problem);
    if (problem || pending || needsReview) return;
    if (requiresCommandConfirmation) { setLocalCommandConfirmed(true); return; }
    if (editing) onUpdate({ writeTarget, edits });
    else onCreate(mcpCreateRequest(form, writeTarget));
  }
  return <Modal centered opened onClose={onClose} size={560} title={editing ? "Edit MCP server" : "Add MCP server"}>
    <Stack gap={12}>
      <Text c="dimmed" size="xs">Configuration file: {writeTarget.filePath}</Text>
      {needsReview ? <Alert color="yellow" variant="light"><Stack gap={8}>
        <Text size="sm">Native configuration changed elsewhere. Your unsaved draft remains below. Reviewing the latest configuration replaces this draft with the latest values; reapply your changes before saving.</Text>
        <Button disabled={!canReview} onClick={onReview} size="xs" variant="light">Review latest configuration</Button>
      </Stack></Alert> : null}
      {error || validation ? <Alert color="red" variant="light">{error ?? validation}</Alert> : null}
      <TextInput disabled={editing || pending} label="Name" value={form.name} onChange={(event) => change("name", event.currentTarget.value)} />
      {editing ? <Text c="dimmed" size="sm">Transport: {form.transport === "stdio" ? "Local command" : form.transport === "streamableHttp" ? "HTTP" : "Native transport"}. Add a new server to use a different transport.</Text> :
        <SegmentedControl aria-label="MCP transport" disabled={pending} value={form.transport} onChange={(value) => change("transport", value as McpForm["transport"])} data={[{ label: "HTTP", value: "streamableHttp" }, { label: "Local command", value: "stdio" }]} />}
      {form.transport === "streamableHttp" ? <Stack gap={10}>
        <TextInput label="URL" value={form.url} onChange={(event) => change("url", event.currentTarget.value)} />
        <TextInput label="Bearer token environment variable" value={form.bearerTokenEnvVar} onChange={(event) => change("bearerTokenEnvVar", event.currentTarget.value)} />
        <Textarea label="HTTP headers" description="One name=value per line. Stored values stay hidden unless replaced." value={form.httpHeaders} onChange={(event) => change("httpHeaders", event.currentTarget.value)} />
        <StoredSecretRows actions={form.headerSecrets} label="Stored HTTP headers" onChange={(value) => change("headerSecrets", value)} />
        <Textarea label="Header environment variables" description="One header=environment-variable per line." value={form.envHttpHeaders} onChange={(event) => change("envHttpHeaders", event.currentTarget.value)} />
      </Stack> : form.transport === "stdio" ? <Stack gap={10}>
        <TextInput label="Command" value={form.command} onChange={(event) => change("command", event.currentTarget.value)} />
        <Textarea label="Arguments" description="One argument per line; spaces within a line are preserved." value={form.args} onChange={(event) => change("args", event.currentTarget.value)} />
        <TextInput label="Working directory" value={form.cwd} onChange={(event) => change("cwd", event.currentTarget.value)} />
        <Textarea label="Environment values" description="One name=value per line. Stored values stay hidden unless replaced." value={form.env} onChange={(event) => change("env", event.currentTarget.value)} />
        <StoredSecretRows actions={form.envSecrets} label="Stored environment values" onChange={(value) => change("envSecrets", value)} />
        <Textarea label="Environment variable names" description="One name per line." value={form.envVars} onChange={(event) => change("envVars", event.currentTarget.value)} />
        {requiresCommandConfirmation || localCommandConfirmed ? <Text c="dimmed" size="xs">Codex will run this command locally when loading the MCP server.</Text> : null}
      </Stack> : <Text c="dimmed" size="sm">This native transport's connection settings are preserved.</Text>}
      <Switch label="Enabled" checked={form.enabled} disabled={pending} onChange={(event) => change("enabled", event.currentTarget.checked)} />
      <Switch label="Required" checked={form.required} disabled={pending} onChange={(event) => change("required", event.currentTarget.checked)} />
      <Group justify="flex-end">
        <Button onClick={onClose} size="xs" variant="subtle">Cancel</Button>
        <Button disabled={needsReview || (editing && edits.length === 0)} loading={pending} onClick={submit} size="xs">{requiresCommandConfirmation ? "Confirm local command" : editing ? "Save changes" : "Add server"}</Button>
      </Group>
    </Stack>
  </Modal>;
}
