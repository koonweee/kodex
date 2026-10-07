import type { GoalView } from "./controller";

const statusLabels: Record<GoalView["status"], string> = {
  active: "Active", paused: "Paused", blocked: "Blocked", usageLimited: "Usage limited",
  budgetLimited: "Budget limited", complete: "Complete", done: "Complete",
};

export function goalStatusLabel(goal: GoalView) {
  return statusLabels[goal.status];
}

export function goalUsageLabel(goal: GoalView) {
  const seconds = Math.max(0, Math.floor(goal.timeUsedSeconds));
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  if ("evaluationsUsed" in goal) return `${goal.evaluationsUsed.toLocaleString()} ${goal.evaluationsUsed === 1 ? "evaluation" : "evaluations"} · ${duration}`;
  const tokens = goal.tokensUsed.toLocaleString();
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget.toLocaleString()}`;
  return `${tokens}${budget} tokens · ${duration}`;
}


export function goalIsComplete(goal: GoalView) {
  return goal.status === "complete" || goal.status === "done";
}

export function goalTokenBudget(goal: GoalView | null) {
  return goal && "tokenBudget" in goal ? goal.tokenBudget ?? null : null;
}
