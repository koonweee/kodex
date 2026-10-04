import type { ConfiguredMcpServer, McpServerInstallRequest, McpServerUpdateRequest, NativeConfigWriteTarget } from "../api/client";
import type { SecretAction } from "./McpSecretRows";

export type McpForm = {
  name: string;
  transport: "streamableHttp" | "stdio" | "unknown";
  url: string;
  bearerTokenEnvVar: string;
  httpHeaders: string;
  envHttpHeaders: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  envVars: string;
  enabled: boolean;
  required: boolean;
  envSecrets: Record<string, SecretAction>;
  headerSecrets: Record<string, SecretAction>;
};

export function initialMcpForm(server?: ConfiguredMcpServer): McpForm {
  const transport = server?.transport;
  return {
    name: server?.name ?? "", transport: transport?.type ?? "streamableHttp",
    url: transport?.type === "streamableHttp" ? transport.url : "",
    bearerTokenEnvVar: transport?.type === "streamableHttp" ? transport.bearerTokenEnvVar ?? "" : "",
    httpHeaders: "",
    envHttpHeaders: transport?.type === "streamableHttp" ? formatPairs(transport.envHttpHeaders ?? {}) : "",
    command: transport?.type === "stdio" ? transport.command : "",
    args: transport?.type === "stdio" ? (transport.args ?? []).join("\n") : "",
    cwd: transport?.type === "stdio" ? transport.cwd ?? "" : "",
    env: "", envVars: transport?.type === "stdio" ? (transport.envVars ?? []).join("\n") : "",
    enabled: server?.enabled ?? true, required: server?.required ?? false,
    envSecrets: secretActions(transport?.type === "stdio" ? Object.keys(transport.env ?? {}) : []),
    headerSecrets: secretActions(transport?.type === "streamableHttp" ? Object.keys(transport.httpHeaders ?? {}) : []),
  };
}

export function mcpCreateRequest(form: McpForm, writeTarget: NativeConfigWriteTarget): McpServerInstallRequest {
  return {
    writeTarget, name: form.name.trim(), enabled: form.enabled, ...(form.required ? { required: true } : {}),
    transport: form.transport === "stdio" ? {
      type: "stdio", command: form.command.trim(), args: lines(form.args),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), env: pairs(form.env),
      ...(lines(form.envVars).length ? { envVars: lines(form.envVars) } : {}),
    } : {
      type: "streamableHttp", url: form.url.trim(), httpHeaders: pairs(form.httpHeaders),
      ...(form.bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: form.bearerTokenEnvVar.trim() } : {}),
      ...(Object.keys(pairs(form.envHttpHeaders)).length ? { envHttpHeaders: pairs(form.envHttpHeaders) } : {}),
    },
  };
}

export function mcpLeafEdits(form: McpForm, initial: McpForm): McpServerUpdateRequest["edits"] {
  const edits: McpServerUpdateRequest["edits"] = [];
  const add = (keyPath: string[], value: unknown) => { edits.push({ keyPath, value }); };
  const changed = (key: "enabled" | "required") => { if (form[key] !== initial[key]) add([key], form[key]); };
  changed("enabled"); changed("required");
  const text = (field: "command" | "url" | "cwd" | "bearerTokenEnvVar", key: string) => {
    if (form[field] !== initial[field]) add([key], form[field].trim() || null);
  };
  const list = (field: "args" | "envVars", key: string) => {
    if (form[field] !== initial[field]) add([key], lines(form[field]));
  };
  const secrets = (key: string, entered: string, actions: Record<string, SecretAction>) => {
    const changes = new Map<string, string | null>(Object.entries(pairs(entered)));
    for (const [name, action] of Object.entries(actions)) {
      if (action.mode === "clear") changes.set(name, null);
      else if (action.mode === "replace") changes.set(name, action.value);
    }
    for (const [name, value] of changes) add([key, name], value);
  };
  if (form.transport === "stdio") {
    text("command", "command"); text("cwd", "cwd"); list("args", "args"); list("envVars", "env_vars");
    secrets("env", form.env, form.envSecrets);
  } else if (form.transport === "streamableHttp") {
    text("url", "url"); text("bearerTokenEnvVar", "bearer_token_env_var");
    secrets("http_headers", form.httpHeaders, form.headerSecrets);
    const before = new Map(Object.entries(pairs(initial.envHttpHeaders)));
    const after = new Map(Object.entries(pairs(form.envHttpHeaders)));
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(name) !== after.get(name)) add(["env_http_headers", name], after.get(name) ?? null);
    }
  }
  return edits;
}

export function mcpFormError(form: McpForm): string | null {
  if (!form.name.trim()) return "Enter a server name.";
  if (form.transport === "streamableHttp" && !form.url.trim()) return "Enter a server URL.";
  if (form.transport === "stdio" && !form.command.trim()) return "Enter a command.";
  return null;
}

function secretActions(keys: string[]): Record<string, SecretAction> {
  return Object.fromEntries(keys.map((key) => [key, { mode: "unchanged", value: "" } satisfies SecretAction]));
}
function lines(value: string) { return value.split(/\n/).map((line) => line.trim()).filter(Boolean); }
function formatPairs(values: Record<string, string>) { return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"); }
function pairs(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }).filter(([key]) => key.length > 0));
}
