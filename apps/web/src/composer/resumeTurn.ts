import type { TimelineState } from "../timeline/state";

/** Presentation hint from canonical history; the gateway rechecks the native head on click. */
export function resumableTurnId(timeline: Pick<TimelineState, "activeTurnId" | "turns">): string | null {
  if (timeline.activeTurnId) return null;
  const latest = timeline.turns.at(-1);
  return latest?.status === "interrupted" ? latest.turnId : null;
}
