import type { EventEnvelope } from "../api/client";
import { eventItem, isErrorEvent, isWarningEvent, payloadRecord, stringValue } from "./presentationShared";

export function presentationItemId(event: EventEnvelope, itemType: string): string {
  const payloadItemId = stringValue(eventItem(event).id);
  if (itemType === "web_search_group") {
    return `web-search-${event.turnId ?? event.itemId ?? payloadItemId ?? event.id}`;
  }
  return event.itemId ?? payloadItemId ?? event.id;
}

export function normalizedItemType(event: EventEnvelope): string {
  const method = event.codexMethod ?? "";
  const payload = payloadRecord(event.payload);
  const item = eventItem(event);
  const exactItemType = stringValue(item.type).toLowerCase();
  switch (exactItemType) {
    case "agentmessage":
      return "assistant_message";
    case "collabagenttoolcall":
      return "collab_agent_tool_call";
    case "commandexecution":
      return "command_execution";
    case "contextcompaction":
      return "context_compaction";
    case "dynamictoolcall":
      return "dynamic_tool_call";
    case "enteredreviewmode":
      return "review_mode_started";
    case "exitedreviewmode":
      return "review_mode_finished";
    case "filechange":
      return "file_change";
    case "hookprompt":
      return "hook_prompt";
    case "imagegeneration":
    case "image_generation_call":
      return "image_generation";
    case "imageview":
      return "image_view";
    case "mcptoolcall":
      return "mcp_tool_call";
    case "plan":
      return "plan";
    case "reasoning":
      return "reasoning_summary";
    case "usermessage":
      return "user_message";
    case "websearch":
      return "web_search_group";
  }
  const source = [
    method,
    stringValue(payload?.type),
    stringValue(payload?.kind),
    stringValue(item.type),
    stringValue(item.kind),
  ]
    .join(" ")
    .toLowerCase();

  if (isWarningEvent(event)) {
    return "warning";
  }
  if (isErrorEvent(event)) {
    return "error";
  }
  if (source.includes("agentmessage") || source.includes("agent_message")) {
    return "assistant_message";
  }
  if (source.includes("usermessage") || source.includes("user_message")) {
    return "user_message";
  }
  if (source.includes("reasoning")) {
    return "reasoning_summary";
  }
  if (source.includes("websearch") || source.includes("web_search")) {
    return "web_search_group";
  }
  if (source.includes("command")) {
    return "command_execution";
  }
  if (source.includes("filechange") || source.includes("file_change")) {
    return "file_change";
  }
  if (source.includes("mcptool") || source.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (source.includes("dynamictool") || source.includes("dynamic")) {
    return "dynamic_tool_call";
  }
  return "";
}
