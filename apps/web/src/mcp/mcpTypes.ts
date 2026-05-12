import type { ConfiguredMcpServer, McpServerStatus } from "../api/client";

export type MergedMcpServer = {
  configured?: ConfiguredMcpServer;
  name: string;
  runtime?: McpServerStatus;
};

export function mergeMcpServers(configuredServers: ConfiguredMcpServer[], runtimeServers: McpServerStatus[]): MergedMcpServer[] {
  const byName = new Map<string, MergedMcpServer>();
  for (const configured of configuredServers) {
    byName.set(configured.name, { configured, name: configured.name });
  }
  for (const runtime of runtimeServers) {
    const entry = byName.get(runtime.name);
    if (entry) {
      entry.runtime = runtime;
    } else {
      byName.set(runtime.name, { name: runtime.name, runtime });
    }
  }
  return Array.from(byName.values()).sort((first, second) => first.name.localeCompare(second.name));
}

export function authLabel(status: McpServerStatus["authStatus"]): string {
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

export function authColor(status: McpServerStatus["authStatus"]): string {
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

export function transportLabel(server?: ConfiguredMcpServer): string {
  if (!server) {
    return "Runtime only";
  }
  switch (server.transport.type) {
    case "stdio":
      return "Local command";
    case "streamableHttp":
      return "HTTP";
    default:
      return "Configured";
  }
}
