export type TimelineEntry =
  | { phase: "idle"; threadId: null }
  | { phase: "loading" | "aligning" | "ready"; threadId: string };

export const idleTimelineEntry: TimelineEntry = { phase: "idle", threadId: null };
