import type { EventEnvelope } from "../api/client";
import { mergeImages } from "./presentation";
import type { CollabAgentNameMap } from "./presentationCollab";
import {
  createEmptyTimelineIndexes,
  type TimelineCollabAgent,
  type TimelineCollabAgentPresentation,
  type TimelineItem,
  type TimelineRow,
  type WebSearchAction,
} from "./state";

// These stores are fresh and owned by this construction pass. Collect first,
// then sort once; never mutate the indexes of an already published state.
export function createTimelineIndexBuilder() {
  const indexes = createEmptyTimelineIndexes();
  let names: CollabAgentNameMap | null = null;
  const collabItems = new Map<string, TimelineItem>();

  function addItem(item: TimelineItem) {
    const existing = indexes.itemById.get(item.id);
    const next = existing ? mergeTimelineItem(existing, item, item.debugEvents[item.debugEvents.length - 1]) : item;
    indexes.itemById.set(item.id, next);
    if (collabItems.has(item.id) || (next.kind === "collab_agent_tool_call" && next.collab)) {
      names = null;
      if (next.kind === "collab_agent_tool_call" && next.collab) collabItems.set(item.id, next);
      else collabItems.delete(item.id);
    }
    if (existing) return;
    indexes.itemIds.push(item.id);
    if (!item.turnId) return;
    const turn = indexes.turnById.get(item.turnId);
    if (turn) {
      turn.itemIds.push(item.id);
    } else {
      indexes.turnIds.push(item.turnId);
      indexes.turnById.set(item.turnId, { turnId: item.turnId, itemIds: [item.id] });
    }
  }

  function addRow(row: TimelineRow) {
    if (row.type === "item") addItem(row.item);
    else if (row.type === "activity") row.items.forEach(addItem);
    else if (row.type === "work") row.collapsedRows.forEach(addRow);
  }

  function collabAgentNames(): CollabAgentNameMap {
    if (names) return names;
    names = new Map();
    // Only collaboration changes invalidate names. Sorting these few items
    // preserves native display order even when grouped children interleave.
    const ordered = [...collabItems.values()].sort((left, right) => left.displayOrder - right.displayOrder);
    for (const item of ordered) {
      for (const agent of item.collab?.agents ?? []) {
        names.set(agent.threadId, mergeCollabAgentName(names.get(agent.threadId), agent));
      }
    }
    return names;
  }

  return {
    addItem,
    addRow,
    collabAgentNames,
    itemById: (itemId: string) => indexes.itemById.get(itemId),
    finish: () => {
      indexes.itemIds.sort((left, right) => indexes.itemById.get(left)!.displayOrder - indexes.itemById.get(right)!.displayOrder);
      return indexes;
    },
  };
}

export function buildTimelineIndexesFromRows(rows: TimelineRow[]) {
  const builder = createTimelineIndexBuilder();
  rows.forEach(builder.addRow);
  return builder.finish();
}

function mergeTimelineItem(existing: TimelineItem, incoming: TimelineItem, event: EventEnvelope): TimelineItem {
  const compactEvent = compactStoredTimelineEvent(event);
  return {
    ...existing,
    ...incoming,
    actions: mergeActions(existing.actions, incoming.actions),
    argsSummary: incoming.argsSummary || existing.argsSummary,
    collab: mergeCollabPresentation(existing.collab, incoming.collab),
    command: incoming.command || existing.command,
    cwd: incoming.cwd || existing.cwd,
    debugEvents: [...existing.debugEvents, compactEvent],
    imageSrc: incoming.imageSrc || existing.imageSrc,
    kind: incoming.kind === "debug_event" && existing.kind !== "debug_event" ? existing.kind : incoming.kind,
    output: incoming.output || existing.output,
    path: incoming.path || existing.path,
    messagePhase: incoming.messagePhase || existing.messagePhase,
    images: mergeImages(existing.images, incoming.images),
    skillMentions: incoming.skillMentions ?? existing.skillMentions,
    payload: compactStoredPayload(incoming),
    resultSummary: incoming.resultSummary || existing.resultSummary,
    displayOrder: incoming.displayOrder,
    timestampMs: incoming.timestampMs ?? existing.timestampMs,
    status: incoming.status,
    toolName: incoming.toolName || existing.toolName,
    text: incoming.text || existing.text,
  };
}

function mergeCollabAgentName(
  prior: TimelineCollabAgent | undefined,
  incoming: TimelineCollabAgent,
): TimelineCollabAgent {
  if (!prior) {
    return incoming;
  }
  if (incoming.nickname || (!prior.nickname && incoming.role && incoming.nameSource !== "ordinal")) {
    return { ...prior, ...incoming };
  }
  return {
    ...incoming,
    displayName: prior.displayName,
    nameSource: prior.nameSource,
    nickname: prior.nickname,
    role: incoming.role || prior.role,
  };
}

function mergeCollabPresentation(
  existing: TimelineCollabAgentPresentation | undefined,
  incoming: TimelineCollabAgentPresentation | undefined,
): TimelineCollabAgentPresentation | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  const agentsByThreadId = new Map(existing.agents.map((agent) => [agent.threadId, agent]));
  for (const agent of incoming.agents) {
    const prior = agentsByThreadId.get(agent.threadId);
    agentsByThreadId.set(agent.threadId, prior ? { ...prior, ...agent } : agent);
  }
  return {
    agents: [...agentsByThreadId.values()],
    prompt: incoming.prompt || existing.prompt,
    model: incoming.model || existing.model,
    reasoningEffort: incoming.reasoningEffort || existing.reasoningEffort,
  };
}

function mergeActions(
  existing: WebSearchAction[] | undefined,
  incoming: WebSearchAction[] | undefined,
): WebSearchAction[] | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  return [...(existing ?? []), ...(incoming ?? [])];
}

function compactStoredPayload(item: TimelineItem): unknown {
  if (item.source === "app_server") {
    return {};
  }
  return item.payload;
}

export function compactStoredTimelineEvent(event: EventEnvelope): EventEnvelope {
  return {
    ...event,
    payload: {},
  };
}

