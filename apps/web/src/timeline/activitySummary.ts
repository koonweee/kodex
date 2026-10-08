import { fileChangeItemSummary } from "./fileRenderers";
import { displayCommand, payloadValue, sentenceCase, timelineItemLabels } from "./rendererShared";
import type { TimelineItem, WebSearchAction } from "./reducer";

export function webSearchActionText(action: WebSearchAction): string {
  if (action.kind === "search") {
    return `Searched web for "${action.query}"`;
  }
  if (action.kind === "open") {
    const target = action.title || action.url;
    return target ? `Opened page ${target}` : "Opened page";
  }
  return action.label;
}

export function activityGroupSummary(items: TimelineItem[]): string {
  const commandCount = items.filter((item) => item.kind === "command_execution").length;
  const fileCount = items.filter((item) => item.kind === "file_change" && item.fileChangeOutcomeKnown !== false).length;
  const fileOperationCount = items.filter((item) => item.kind === "file_change" && item.fileChangeOutcomeKnown === false).length;
  const webCount = items.filter((item) => item.kind === "web_search_group").length;
  const toolCount = items.filter((item) => item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call").length;
  const agentCount = collabAgentCount(items);
  const generatedImageCount = items.filter((item) => item.kind === "image_generation").length;
  const viewedImageCount = items.filter((item) => item.kind === "image_view").length;
  const parts = [
    webCount ? "Searched web" : "",
    fileCount ? fileCount === 1 ? "changed 1 file" : `changed ${fileCount} files` : "",
    fileOperationCount ? fileOperationCount === 1 ? "requested 1 file operation" : `requested ${fileOperationCount} file operations` : "",
    toolCount ? toolCount === 1 ? "used 1 tool" : `used ${toolCount} tools` : "",
    agentCount ? agentCount === 1 ? "used 1 agent" : `used ${agentCount} agents` : "",
    generatedImageCount ? generatedImageCount === 1 ? "generated 1 image" : `generated ${generatedImageCount} images` : "",
    viewedImageCount ? viewedImageCount === 1 ? "viewed 1 image" : `viewed ${viewedImageCount} images` : "",
    commandCount ? commandCount === 1 ? "ran 1 command" : `ran ${commandCount} commands` : "",
  ].filter(Boolean);
  return parts.length ? sentenceCase(parts.join(", ")) : "Worked";
}

export function commandSummary(item: TimelineItem): string {
  const command = displayCommand(item.command || payloadValue(item.payload, "command"));
  if (!command) {
    return "Ran command";
  }
  if (command === "rg --files" || command === "find . -maxdepth 1 -type f" || command === "ls") {
    return "Listed files";
  }
  return `Ran ${command}`;
}

export function activityItemSummary(item: TimelineItem): string {
  if (item.kind === "file_change") {
    return fileChangeItemSummary(item);
  }
  if (item.kind === "web_search_group") {
    const count = item.actions?.length ?? 0;
    return count === 1 ? "Searched web" : `Searched web, ${count} actions`;
  }
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") {
    return item.toolName ? `Used ${item.toolName}` : "Used tool";
  }
  if (item.kind === "collab_agent_tool_call") {
    return collabActivitySummary(item);
  }
  if (item.kind === "image_view" || item.kind === "image_generation") {
    return item.text || "Image activity";
  }
  return timelineItemLabels[item.kind] ?? "Activity";
}

function collabActivitySummary(item: TimelineItem): string {
  if (item.toolName === "wait" && item.status === "running" && item.collab && item.collab.agents.length > 1) {
    return `Waiting for ${item.collab.agents.length} agents`;
  }
  if (item.text) {
    return item.text;
  }
  return "Agent activity";
}

function collabAgentCount(items: TimelineItem[]): number {
  const agentIds = new Set<string>();
  let fallbackRows = 0;
  for (const item of items) {
    if (item.kind !== "collab_agent_tool_call") {
      continue;
    }
    if (!item.collab?.agents.length) {
      fallbackRows += 1;
      continue;
    }
    for (const agent of item.collab.agents) {
      agentIds.add(agent.threadId);
    }
  }
  return agentIds.size || fallbackRows;
}
