import { Tooltip } from "@mantine/core";
import type { ThreadListEntry as ThreadSummary } from "./viewTypes";
import { threadInProgress } from "./helpers";
import "../styles/thread-status-indicator.css";

export function threadIndicatorState(thread: ThreadSummary | undefined) {
  return thread && threadInProgress(thread) ? "running" : thread?.unreadCompletedAgentTurn === true ? "unread" : null;
}

export function ThreadStatusIndicator({ state, className }: {
  state: NonNullable<ReturnType<typeof threadIndicatorState>>;
  className?: string;
}) {
  const running = state === "running";
  const label = running ? "Thread in progress" : "Unread completed agent turn";
  return (
    <Tooltip label={label}>
      <span aria-label={label} className={className} role={running ? "status" : "img"}>
        <span className={running ? "kodex-thread-progress-indicator" : "kodex-thread-unread-agent-turn-indicator"} />
      </span>
    </Tooltip>
  );
}
