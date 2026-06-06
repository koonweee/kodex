import type { TimelineCollabAgent, TimelineCollabAgentPresentation, TimelineStatus } from "./state";
import { payloadRecord, stringValue, truncateSummary, uniqueValues } from "./presentationShared";

export type CollabAgentNameMap = Map<string, TimelineCollabAgent>;

export function collabAgentToolCallLabel(
  item: Record<string, unknown>,
  status: TimelineStatus,
  collab?: TimelineCollabAgentPresentation,
): string {
  const tool = stringValue(item.tool);
  const agent = collab?.agents[0];
  const agentName = agent?.displayName;
  const agentCount = collab?.agents.length ?? 0;
  if (tool === "spawnAgent") {
    if (status === "running") {
      return agentName ? `Spawning ${agentName}` : "Spawning agent";
    }
    return status === "failed" || !hasCollabReceiver(item)
      ? agentName && agent?.nameSource !== "ordinal"
        ? `Failed to spawn ${agentName}`
        : "Agent spawn failed"
      : agentName
        ? `Spawned ${agentName}`
        : "Spawned agent";
  }
  if (tool === "sendInput") {
    return status === "running"
      ? agentName
        ? `Sending input to ${agentName}`
        : "Sending input to agent"
      : agentName
        ? `Sent input to ${agentName}`
        : "Sent input to agent";
  }
  if (tool === "wait") {
    if (status === "running") {
      return agentCount > 1 ? `Waiting for ${agentCount} agents` : agentName ? `Waiting for ${agentName}` : "Waiting for agent";
    }
    return "Finished waiting";
  }
  if (tool === "resumeAgent") {
    return status === "running"
      ? agentName
        ? `Resuming ${agentName}`
        : "Resuming agent"
      : agentName
        ? `Resumed ${agentName}`
        : "Resumed agent";
  }
  if (tool === "closeAgent") {
    return status === "running"
      ? agentName
        ? `Closing ${agentName}`
        : "Closing agent"
      : agentName
        ? `Closed ${agentName}`
        : "Closed agent";
  }
  return tool || "Agent activity";
}

export function collabAgentPresentation(
  item: Record<string, unknown>,
  existingNames: CollabAgentNameMap = new Map(),
): TimelineCollabAgentPresentation {
  const agentsStates = payloadRecord(item.agentsStates);
  const receiverThreadIds = collabReceiverIds(item.receiverThreadIds);
  const threadIds = uniqueValues([...receiverThreadIds, ...Object.keys(agentsStates ?? {})]);
  const nickname = firstString(item.agent_nickname, item.agentNickname);
  const role = firstString(item.agent_role, item.agentRole);
  const workingNames: CollabAgentNameMap = new Map(existingNames);
  const agents = threadIds.map((threadId) => {
    const state = payloadRecord(agentsStates?.[threadId]);
    const rawStatus = stringValue(state?.status);
    const message = stringValue(state?.message);
    const prior = workingNames.get(threadId);
    const name = collabAgentDisplayName({ existingNames: workingNames, nickname, prior, role, threadId });
    const agent = {
      threadId,
      displayName: name.displayName,
      nickname: name.nickname,
      role: name.role,
      status: rawStatus ? collabAgentStatusLabel(rawStatus) : undefined,
      rawStatus: rawStatus || undefined,
      message: message || undefined,
      nameSource: name.nameSource,
    };
    workingNames.set(threadId, agent);
    return agent;
  });
  return {
    agents,
    prompt: stringValue(item.prompt) || undefined,
    model: stringValue(item.model) || undefined,
    reasoningEffort: stringValue(item.reasoningEffort) || undefined,
  };
}

function collabAgentDisplayName({
  existingNames,
  nickname,
  prior,
  role,
  threadId,
}: {
  existingNames: CollabAgentNameMap;
  nickname?: string;
  prior?: TimelineCollabAgent;
  role?: string;
  threadId: string;
}): Pick<TimelineCollabAgent, "displayName" | "nameSource" | "nickname" | "role"> {
  const nextNickname = nickname || prior?.nickname;
  const nextRole = role || prior?.role;
  if (nextNickname) {
    return {
      displayName: nextRole ? `${nextNickname} [${nextRole}]` : nextNickname,
      nameSource: "metadata",
      nickname: nextNickname,
      role: nextRole,
    };
  }
  if (prior?.displayName && prior.nameSource !== "ordinal") {
    return {
      displayName: prior.displayName,
      nameSource: prior.nameSource,
      nickname: prior.nickname,
      role: nextRole,
    };
  }
  if (nextRole) {
    const displayRole = titleCase(nextRole);
    return {
      displayName: prior?.displayName && prior.nameSource === "role" ? prior.displayName : `${displayRole} ${roleOrdinal(existingNames, nextRole, threadId)}`,
      nameSource: "role",
      role: nextRole,
    };
  }
  if (prior?.displayName) {
    return {
      displayName: prior.displayName,
      nameSource: prior.nameSource ?? "ordinal",
      nickname: prior.nickname,
      role: prior.role,
    };
  }
  return {
    displayName: `Agent ${ordinalAgentNumber(existingNames, threadId)}`,
    nameSource: "ordinal",
  };
}

function collabAgentStatusLabel(status: string): string {
  const normalized = status.trim();
  if (normalized === "pendingInit") {
    return "Pending init";
  }
  if (normalized === "notFound") {
    return "Not found";
  }
  if (normalized === "errored") {
    return "Error";
  }
  return titleCase(normalized);
}

export function collabAgentArgsSummary(item: Record<string, unknown>, collab?: TimelineCollabAgentPresentation): string {
  const parts = [
    collab?.model ? `model: ${collab.model}` : "",
    collab?.reasoningEffort ? `reasoning: ${collabAgentStatusLabel(collab.reasoningEffort)}` : "",
    collab?.agents.length ? collab.agents.map((agent) => agent.displayName).join(", ") : collabReceiverSummary(item.receiverThreadIds),
    collab?.prompt ? `prompt: ${truncateSummary(collab.prompt, 160)}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

export function collabAgentResultSummary(item: Record<string, unknown>, collab?: TimelineCollabAgentPresentation): string {
  if (collab?.agents.length) {
    return collab.agents
      .filter((agent) => agent.status || agent.message)
      .map((agent) => [agent.displayName, agent.status, agent.message].filter(Boolean).join(": "))
      .join("; ");
  }
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

function collabReceiverIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function collabReceiverSummary(value: unknown): string {
  const ids = collabReceiverIds(value);
  if (ids.length === 0) {
    return "";
  }
  return ids.length === 1 ? `receiver: ${ids[0]}` : `receivers: ${ids.join(", ")}`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function ordinalAgentNumber(existingNames: CollabAgentNameMap, threadId: string): number {
  let count = 0;
  for (const [existingThreadId, agent] of existingNames) {
    if (existingThreadId === threadId) {
      break;
    }
    if (agent.nameSource === "ordinal" || /^Agent \d+$/.test(agent.displayName)) {
      count += 1;
    }
  }
  return count + 1;
}

function roleOrdinal(existingNames: CollabAgentNameMap, role: string, threadId: string): number {
  let count = 0;
  for (const [existingThreadId, agent] of existingNames) {
    if (existingThreadId === threadId) {
      break;
    }
    if (agent.role === role && (agent.nameSource === "role" || !agent.nickname)) {
      count += 1;
    }
  }
  return count + 1;
}

function titleCase(value: string): string {
  if (!value) {
    return value;
  }
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
}
