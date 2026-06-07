import type { FollowOutput } from "react-virtuoso";

const TIMELINE_BOTTOM_FOLLOW_THRESHOLD = 60;

export type TimelineScrollBehavior = "auto" | "smooth";

export function timelineFollowOutputBehavior(isNearBottom: boolean): ReturnType<Exclude<FollowOutput, boolean | string>> {
  return isNearBottom ? "auto" : false;
}

export function getDistanceFromBottom(scrollElement: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">) {
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
}

export function isTimelineNearBottom(scrollElement: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">) {
  return getDistanceFromBottom(scrollElement) < TIMELINE_BOTTOM_FOLLOW_THRESHOLD;
}

export function getScrollElementBottomTop(scrollElement: Pick<HTMLElement, "clientHeight" | "scrollHeight">) {
  return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
}
