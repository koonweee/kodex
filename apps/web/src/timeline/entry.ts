export type TimelineEntry =
  | { phase: "idle"; threadId: null }
  | { phase: "loadingSnapshot" | "streamingLive" | "refreshingSnapshot" | "error"; threadId: string };

export const idleTimelineEntry: TimelineEntry = { phase: "idle", threadId: null };
