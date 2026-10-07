import type { EventEnvelope, ThreadSummary } from "../api/client";
import { asRecord, stringValue } from "../shared/values";
import { threadHasDisplayTitle } from "./helpers";

export type SidebarThreadLocation =
  | { scope: "project"; projectId: string; thread: ThreadSummary }
  | { scope: "chat"; thread: ThreadSummary }
  | { scope: "pinned"; thread: ThreadSummary };

export type SidebarLiveCacheRoute =
  | { kind: "ignore" }
  | { kind: "refillSidebar"; threadId: string }
  | { kind: "invalidateKnownThreadList"; location: SidebarThreadLocation; reason: "missingDisplayTitle" };

export function sidebarLiveCacheRoute(event: EventEnvelope, location: SidebarThreadLocation | null): SidebarLiveCacheRoute {
  if (event.kind === "thread.summary_changed" || event.codexMethod === "thread/name/updated") {
    const threadId = event.threadId ?? stringValue(asRecord(event.payload).threadId);
    return threadId ? { kind: "refillSidebar", threadId } : { kind: "ignore" };
  }
  if (!event.threadId || !eventCanRefreshSidebarThread(event)) {
    return { kind: "ignore" };
  }
  if (!location) {
    return { kind: "ignore" };
  }
  if (event.kind === "thread_view.patch" && !threadHasDisplayTitle(location.thread)) {
    return { kind: "invalidateKnownThreadList", location, reason: "missingDisplayTitle" };
  }
  return { kind: "ignore" };
}

function eventCanRefreshSidebarThread(event: EventEnvelope) {
  return event.kind === "thread_view.patch" || event.kind === "timeline.thread_metadata";
}
