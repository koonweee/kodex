import type { ThreadGoal } from "../api/client";

const statusLabels: Record<ThreadGoal["status"], string> = {
  active: "Active", paused: "Paused", blocked: "Blocked", usageLimited: "Usage limited",
  budgetLimited: "Budget limited", complete: "Complete",
};

export function goalStatusLabel(goal: ThreadGoal) {
  return statusLabels[goal.status];
}

export function goalUsageLabel(goal: ThreadGoal) {
  const tokens = goal.tokensUsed.toLocaleString();
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget.toLocaleString()}`;
  const seconds = Math.max(0, Math.floor(goal.timeUsedSeconds));
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${tokens}${budget} tokens · ${duration}`;
}
