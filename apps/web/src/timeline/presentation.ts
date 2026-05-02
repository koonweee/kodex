import type { EventEnvelope } from "../api/client";
import type { TimelineItem } from "./state";
import {
  collabAgentArgsSummary,
  collabAgentResultSummary,
  collabAgentToolCallLabel,
} from "./presentationCollab";
import { fileChangeSummary } from "./presentationFile";
import { mergeImages, payloadImages } from "./presentationImages";
import { normalizedItemType, presentationItemId } from "./presentationItemType";
import {
  createBaseItem,
  eventItem,
  eventStatus,
  isErrorEvent,
  isLifecycleEvent,
  isWarningEvent,
  payloadRecord,
  stringValue,
  summarizeValue,
} from "./presentationShared";
import { payloadText, reasoningSummary } from "./presentationText";
import { actionLabel, webSearchAction } from "./presentationWeb";

export type TimelinePresentationItem = { item: TimelineItem; hidden?: boolean; text?: string };

export { createBaseItem, eventStatus, isErrorEvent, isLifecycleEvent, isWarningEvent, mergeImages };

export function createPresentationItem(
  event: EventEnvelope,
  existingItem?: TimelineItem,
): TimelinePresentationItem | null {
  const item = eventItem(event);
  const itemType = normalizedItemType(event);
  const text = payloadText(event.payload);
  const status = eventStatus(event);
  const id = presentationItemId(event, itemType);
  const base = createBaseItem(event, id, itemType || existingItem?.kind || "", status);

  if (itemType === "assistant_message") {
    const messagePhase = stringValue(item.phase) || stringValue(payloadRecord(event.payload)?.phase);
    return {
      item: {
        ...base,
        messagePhase,
        text,
      },
      hidden: !text,
      text: "Empty assistant message",
    };
  }

  if (itemType === "user_message") {
    const images = payloadImages(event.payload);
    return {
      item: {
        ...base,
        images,
        text,
      },
      hidden: !text && images.length === 0,
      text: "Empty user message",
    };
  }

  if (itemType === "reasoning_summary") {
    const summary = reasoningSummary(event.payload);
    return {
      item: {
        ...base,
        summary,
        text: summary,
      },
      hidden: !summary,
      text: "Empty reasoning",
    };
  }

  if (itemType === "web_search_group") {
    const action = webSearchAction(event.payload);
    return {
      item: {
        ...base,
        actions: action ? [action] : [],
        text: actionLabel(action),
      },
      hidden: !action,
      text: "Unsupported web search action",
    };
  }

  if (itemType === "command_execution") {
    const command = stringValue(item.command) || stringValue(payloadRecord(event.payload)?.command);
    const cwd = stringValue(item.cwd) || stringValue(payloadRecord(event.payload)?.cwd);
    const output =
      stringValue(item.output) ||
      stringValue(item.stdout) ||
      stringValue(item.stderr) ||
      stringValue(payloadRecord(event.payload)?.output);
    return {
      item: {
        ...base,
        command,
        cwd,
        output,
        text: command || text,
      },
      hidden: !command && !text,
      text: "Empty command execution",
    };
  }

  if (itemType === "file_change") {
    const changeSummary = fileChangeSummary(item.changes);
    const path = stringValue(item.path) || stringValue(payloadRecord(event.payload)?.path) || changeSummary.path;
    const action =
      stringValue(item.action) ||
      stringValue(item.change) ||
      stringValue(payloadRecord(event.payload)?.action) ||
      changeSummary.action;
    return {
      item: {
        ...base,
        action,
        output: changeSummary.diff,
        path,
        text: [action, path].filter(Boolean).join(" "),
      },
      hidden: !path && !action,
      text: "Empty file change",
    };
  }

  if (itemType === "mcp_tool_call" || itemType === "dynamic_tool_call") {
    const toolName =
      stringValue(item.toolName) ||
      stringValue(item.name) ||
      stringValue(item.tool) ||
      stringValue(payloadRecord(event.payload)?.toolName) ||
      stringValue(payloadRecord(event.payload)?.name);
    const args = item.arguments ?? item.args ?? payloadRecord(event.payload)?.arguments ?? payloadRecord(event.payload)?.args;
    const result = item.result ?? item.output ?? payloadRecord(event.payload)?.result ?? payloadRecord(event.payload)?.output;
    return {
      item: {
        ...base,
        argsSummary: summarizeValue(args),
        resultSummary: summarizeValue(result),
        text: toolName || text,
        toolName,
      },
      hidden: !toolName && !text,
      text: "Empty tool call",
    };
  }

  if (itemType === "collab_agent_tool_call") {
    const tool = stringValue(item.tool);
    return {
      item: {
        ...base,
        argsSummary: collabAgentArgsSummary(item),
        resultSummary: collabAgentResultSummary(item),
        text: collabAgentToolCallLabel(item, status),
        toolName: tool,
      },
      hidden: !tool,
      text: "Empty collaboration activity",
    };
  }

  if (itemType === "plan") {
    return {
      item: {
        ...base,
        text,
      },
      hidden: !text,
      text: "Empty plan",
    };
  }

  if (itemType === "image_view") {
    const path = stringValue(item.path);
    return {
      item: {
        ...base,
        path,
        text: "Viewed image",
      },
      hidden: !path,
      text: "Empty image view",
    };
  }

  if (itemType === "image_generation") {
    const path = stringValue(item.savedPath) || stringValue(item.saved_path);
    const revisedPrompt = stringValue(item.revisedPrompt) || stringValue(item.revised_prompt);
    const result = stringValue(item.result);
    return {
      item: {
        ...base,
        imageSrc: result ? imageDataUrl(result) : undefined,
        path,
        resultSummary: revisedPrompt,
        text: "Generated image",
      },
    };
  }

  if (itemType === "review_mode_started") {
    const review = stringValue(item.review);
    return {
      item: {
        ...base,
        text: review ? `Code review started: ${review}` : "Code review started",
      },
    };
  }

  if (itemType === "review_mode_finished") {
    return {
      item: {
        ...base,
        text: "Code review finished",
      },
    };
  }

  if (itemType === "context_compaction") {
    return {
      item: {
        ...base,
        text: "Context compacted",
      },
    };
  }

  if (itemType === "hook_prompt") {
    return {
      item: base,
      hidden: true,
      text: "Hook prompt",
    };
  }

  if (itemType === "warning" || itemType === "error") {
    return { item: createDiagnosticItem(event) };
  }

  if (event.itemId) {
    if (existingItem) {
      return {
        item: {
          ...base,
          text,
        },
        hidden: !text,
        text: text ? undefined : "Empty item update",
      };
    }
    return {
      item: base,
      hidden: true,
      text: text || "Unsupported item",
    };
  }

  return null;
}

function imageDataUrl(result: string): string {
  return result.startsWith("data:image/") ? result : `data:image/png;base64,${result}`;
}

export function createDiagnosticItem(event: EventEnvelope): TimelineItem {
  return {
    ...createBaseItem(event, event.itemId ?? `diagnostic-${event.id}`, isErrorEvent(event) ? "error" : "warning", eventStatus(event)),
    text: payloadText(event.payload) || (isErrorEvent(event) ? "Error" : "Warning"),
  };
}
