import type { EventEnvelope, ThreadSummary } from "../api/client";
import { threadHasDisplayTitle } from "./helpers";

export type SidebarThreadLocation =
  | { scope: "project"; projectId: string; thread: ThreadSummary }
  | { scope: "chat"; thread: ThreadSummary };

export type SidebarLiveCacheRoute =
  | { kind: "ignore" }
  | { kind: "invalidateAllThreadLists"; reason: "missingThreadMetadata" }
  | { kind: "invalidateKnownThreadList"; location: SidebarThreadLocation; reason: "missingDisplayTitle" };

export function sidebarLiveCacheRoute(event: EventEnvelope, location: SidebarThreadLocation | null): SidebarLiveCacheRoute {
  if (!event.threadId || !eventCanRefreshSidebarThread(event)) {
    return { kind: "ignore" };
  }
  if (!location) {
    return event.kind === "thread_view.patch"
      ? { kind: "invalidateAllThreadLists", reason: "missingThreadMetadata" }
      : { kind: "ignore" };
  }
  if (event.kind === "thread_view.patch" && !threadHasDisplayTitle(location.thread)) {
    return { kind: "invalidateKnownThreadList", location, reason: "missingDisplayTitle" };
  }
  return { kind: "ignore" };
}

function eventCanRefreshSidebarThread(event: EventEnvelope) {
  return event.kind === "thread_view.patch" || event.kind === "timeline.thread_metadata";
}
