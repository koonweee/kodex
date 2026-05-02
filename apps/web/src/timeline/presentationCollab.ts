import type { TimelineStatus } from "./state";
import { payloadRecord, stringValue, truncateSummary } from "./presentationShared";

export function collabAgentToolCallLabel(item: Record<string, unknown>, status: TimelineStatus): string {
  const tool = stringValue(item.tool);
  if (tool === "spawnAgent") {
    if (status === "running") {
      return "Spawning agent";
    }
    return status === "failed" || !hasCollabReceiver(item) ? "Agent spawn failed" : "Spawned agent";
  }
  if (tool === "sendInput") {
    return status === "running" ? "Sending input to agent" : "Sent input to agent";
  }
  if (tool === "wait") {
    return status === "running" ? "Waiting for agent" : "Finished waiting";
  }
  if (tool === "resumeAgent") {
    return status === "running" ? "Resuming agent" : "Resumed agent";
  }
  if (tool === "closeAgent") {
    return status === "running" ? "Closing agent" : "Closed agent";
  }
  return tool || "Agent activity";
}

export function collabAgentArgsSummary(item: Record<string, unknown>): string {
  const parts = [
    stringValue(item.model) ? `model: ${stringValue(item.model)}` : "",
    stringValue(item.reasoningEffort) ? `reasoning: ${stringValue(item.reasoningEffort)}` : "",
    collabReceiverSummary(item.receiverThreadIds),
    stringValue(item.prompt) ? `prompt: ${truncateSummary(stringValue(item.prompt), 160)}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

export function collabAgentResultSummary(item: Record<string, unknown>): string {
  const agentsStates = payloadRecord(item.agentsStates);
  if (!agentsStates) {
    return "";
  }
  return Object.entries(agentsStates)
    .map(([threadId, value]) => {
      const state = payloadRecord(value);
      const status = stringValue(state?.status);
      const message = stringValue(state?.message);
      return [threadId, status, message].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
}

function hasCollabReceiver(item: Record<string, unknown>): boolean {
  return Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0;
}

function collabReceiverSummary(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const ids = value.map((item) => stringValue(item)).filter(Boolean);
  if (ids.length === 0) {
    return "";
  }
  return ids.length === 1 ? `receiver: ${ids[0]}` : `receivers: ${ids.join(", ")}`;
}
