import { Tooltip } from "@mantine/core";
import { useSynchronizedAnimation } from "../ui/useSynchronizedAnimation";
import type { ThreadSummary } from "../api/client";
import { threadInProgress } from "./helpers";
import "../styles/thread-status-indicator.css";

export function threadIndicatorState(thread: ThreadSummary | undefined) {
  return thread && threadInProgress(thread) ? "running" : thread?.unreadCompletedAgentTurn === true ? "unread" : null;
}

export function ThreadStatusIndicator({ state, className }: {
  state: NonNullable<ReturnType<typeof threadIndicatorState>>;
  className?: string;
}) {
  const animationRef = useSynchronizedAnimation<HTMLSpanElement>(state);
  const running = state === "running";
  const label = running ? "Thread in progress" : "Unread completed agent turn";
  return (
    <Tooltip label={label}>
      <span ref={animationRef} aria-label={label} className={className} role={running ? "status" : "img"}>
        <span className={running ? "kodex-thread-progress-indicator" : "kodex-thread-unread-agent-turn-indicator"} />
      </span>
    </Tooltip>
  );
}
