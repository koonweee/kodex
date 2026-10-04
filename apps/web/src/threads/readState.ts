import type { ThreadRead, ThreadSummary } from "../api/client";

type ReadMarker = Pick<ThreadRead,
  "latestCompletedTurnId" | "seenCompletedTurnId" | "readRevision" | "readStateKnown" | "unreadCompletedAgentTurn"
>;

// Read revisions are gateway-owned and independent of native metadata timestamps.
// Replace the tuple together, including null/unknown state after a native reset.
export function mergeThreadReadState<T extends ReadMarker>(current: T, update: ReadMarker): T {
  if (update.readRevision <= current.readRevision) return current;
  return { ...current, ...readMarker(update) };
}

export function preserveNewerThreadReadState(current: ThreadSummary, update: ThreadSummary): ThreadSummary {
  return current.readRevision > update.readRevision
    ? { ...update, ...readMarker(current) }
    : update;
}

function readMarker(state: ReadMarker): ReadMarker {
  return {
    latestCompletedTurnId: state.latestCompletedTurnId,
    seenCompletedTurnId: state.seenCompletedTurnId,
    readRevision: state.readRevision,
    readStateKnown: state.readStateKnown,
    unreadCompletedAgentTurn: state.unreadCompletedAgentTurn,
  };
}
