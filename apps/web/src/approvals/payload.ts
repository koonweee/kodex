import type { Approval } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

const APPROVAL_TEXT = {
  commandTitle: "Would you like to run the following command?",
  fallbackTitle: "Approval request",
  fileTitle: "Would you like to make the following edits?",
  permissionsTitle: "Would you like to grant these permissions?",
  toolInputTitle: "Input requested",
};

export type NormalizedApprovalMethod =
  | "command"
  | "file"
  | "permissions"
  | "mcp_elicitation"
  | "tool_user_input"
  | "unknown";

export function approvalTitle(approval: Approval): string {
  const payload = asRecord(approval.payload);
  switch (normalizedApprovalMethod(approval.method)) {
    case "command": {
      const host = approvalNetworkHost(payload);
      if (host) {
        return `Do you want to approve network access to "${host}"?`;
      }
      return APPROVAL_TEXT.commandTitle;
    }
    case "file":
      return APPROVAL_TEXT.fileTitle;
    case "permissions":
      return APPROVAL_TEXT.permissionsTitle;
    case "mcp_elicitation":
      return `${approvalServerName(approval) ?? "MCP server"} needs your approval.`;
    case "tool_user_input":
      return APPROVAL_TEXT.toolInputTitle;
    default:
      return APPROVAL_TEXT.fallbackTitle;
  }
}

export function approvalSubject(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  if (normalizedApprovalMethod(approval.method) === "command" && approvalNetworkHost(payload)) {
    return null;
  }
  return (
    stringValue(payload.command) ??
    stringValue(payload.path) ??
    stringValue(payload.message) ??
    firstQuestionText(payload)
  );
}

export function approvalReason(approval: Approval): string | null {
  return stringValue(asRecord(approval.payload).reason);
}

export function approvalServerName(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  return stringValue(payload.serverName) ?? stringValue(payload.server_name);
}

export function approvalPermissionRule(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  if (normalizedApprovalMethod(approval.method) === "permissions") {
    return permissionRuleText(asRecord(payload.permissions));
  }
  if (normalizedApprovalMethod(approval.method) === "command") {
    return permissionRuleText(asRecord(payload.additionalPermissions));
  }
  return null;
}

export function approvalParsedActions(approval: Approval): string[] {
  const payload = asRecord(approval.payload);
  const commandActions = payload.commandActions;
  if (!Array.isArray(commandActions)) {
    return [];
  }

  return commandActions
    .map((action) => commandActionText(asRecord(action)))
    .filter((action): action is string => Boolean(action));
}

export function normalizedApprovalMethod(method: string): NormalizedApprovalMethod {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "command_execution":
    case "command":
      return "command";
    case "item/fileChange/requestApproval":
    case "file_change":
    case "file":
      return "file";
    case "item/permissions/requestApproval":
    case "permissions":
      return "permissions";
    case "mcpServer/elicitation/request":
    case "mcp_elicitation":
      return "mcp_elicitation";
    case "item/tool/requestUserInput":
    case "tool_user_input":
      return "tool_user_input";
    default:
      return "unknown";
  }
}

export function approvalNetworkHost(payload: Record<string, unknown>): string | null {
  return stringValue(asRecord(payload.networkApprovalContext).host);
}

export function approvalPermissions(approval: Approval): Record<string, unknown> {
  const permissions = asRecord(approval.payload).permissions;
  return permissions && typeof permissions === "object" ? (permissions as Record<string, unknown>) : {};
}

function commandActionText(action: Record<string, unknown>): string | null {
  const type = stringValue(action.type);
  const command = stringValue(action.command);
  if (type === "read") {
    const name = stringValue(action.name) ?? stringValue(action.path);
    return name ? `Read ${name}` : command;
  }
  if (type === "listFiles") {
    const path = stringValue(action.path);
    return path ? `List files in ${path}` : "List files";
  }
  if (type === "search") {
    const query = stringValue(action.query);
    const path = stringValue(action.path);
    if (query && path) {
      return `Search ${query} in ${path}`;
    }
    return query ? `Search ${query}` : command;
  }
  return command;
}

function permissionRuleText(permissions: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (asRecord(permissions.network).enabled === true) {
    parts.push("network");
  }
  const fileSystem = asRecord(permissions.fileSystem ?? permissions.file_system);
  const readPaths = permissionPaths(fileSystem.read);
  const writePaths = permissionPaths(fileSystem.write);
  if (readPaths.length > 0) {
    parts.push(`read ${readPaths.join(", ")}`);
  }
  if (writePaths.length > 0) {
    parts.push(`write ${writePaths.join(", ")}`);
  }
  const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries.map(asRecord) : [];
  const entryReads = permissionEntryPaths(entries, "read");
  const entryWrites = permissionEntryPaths(entries, "write");
  const entryDeniedReads = permissionEntryPaths(entries, "none");
  if (entryReads.length > 0) {
    parts.push(`read ${entryReads.join(", ")}`);
  }
  if (entryWrites.length > 0) {
    parts.push(`write ${entryWrites.join(", ")}`);
  }
  if (entryDeniedReads.length > 0) {
    parts.push(`deny read ${entryDeniedReads.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function permissionPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => stringValue(item))
        .filter((item): item is string => Boolean(item))
        .map(formatPathToken)
    : [];
}

function permissionEntryPaths(entries: Record<string, unknown>[], access: string): string[] {
  return entries
    .filter((entry) => stringValue(entry.access) === access)
    .map((entry) => permissionEntryPathLabel(asRecord(entry.path)))
    .filter((item): item is string => Boolean(item));
}

function permissionEntryPathLabel(path: Record<string, unknown>): string | null {
  const directPath = stringValue(path.path);
  if (directPath) {
    return formatPathToken(directPath);
  }
  const pattern = stringValue(path.pattern);
  if (pattern) {
    return `glob \`${pattern}\``;
  }
  const value = asRecord(path.value);
  const kind = stringValue(value.kind);
  if (kind) {
    return formatPathToken(`:${kind}`);
  }
  return null;
}

function formatPathToken(path: string): string {
  return `\`${path}\``;
}

function firstQuestionText(payload: Record<string, unknown>): string | null {
  const questions = payload.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const firstQuestion = asRecord(questions[0]);
  return stringValue(firstQuestion.question) ?? stringValue(firstQuestion.header);
}
