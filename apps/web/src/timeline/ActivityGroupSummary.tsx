import { Text, VisuallyHidden } from "@mantine/core";
import { ActivityCommandCount } from "./ActivityCommandCount";
import { sentenceCase } from "./rendererShared";
import type { TimelineItem } from "./reducer";

export function ActivityGroupSummary({ items }: { items: TimelineItem[] }) {
  const commandCount = items.filter((item) => item.kind === "command_execution").length;
  const fileCount = items.filter((item) => item.kind === "file_change").length;
  const webCount = items.filter((item) => item.kind === "web_search_group").length;
  const toolCount = items.filter((item) => item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call").length;
  const agentCount = collabAgentCount(items);
  const generatedImageCount = items.filter((item) => item.kind === "image_generation").length;
  const viewedImageCount = items.filter((item) => item.kind === "image_view").length;
  const parts = [
    webCount ? "Searched web" : "",
    fileCount ? fileCount === 1 ? "changed 1 file" : `changed ${fileCount} files` : "",
    toolCount ? toolCount === 1 ? "used 1 tool" : `used ${toolCount} tools` : "",
    agentCount ? agentCount === 1 ? "used 1 agent" : `used ${agentCount} agents` : "",
    generatedImageCount ? generatedImageCount === 1 ? "generated 1 image" : `generated ${generatedImageCount} images` : "",
    viewedImageCount ? viewedImageCount === 1 ? "viewed 1 image" : `viewed ${viewedImageCount} images` : "",
  ].filter(Boolean);
  const prefix = commandCount
    ? parts.length ? `${sentenceCase(parts.join(", "))}, ran ` : "Ran "
    : parts.length ? sentenceCase(parts.join(", ")) : "Worked";
  const suffix = commandCount === 1 ? " command" : " commands";
  const summary = commandCount ? `${prefix}${commandCount}${suffix}` : prefix;
  return (
    <Text size="xs" c="dimmed" fw={700} className="kodex-activity-group-title" title={summary}>
      {commandCount > 0 ? (
        <>
          <VisuallyHidden>{summary}</VisuallyHidden>
          <span aria-hidden="true">
            {prefix}<ActivityCommandCount value={commandCount} />{suffix}
          </span>
        </>
      ) : summary}
    </Text>
  );
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
