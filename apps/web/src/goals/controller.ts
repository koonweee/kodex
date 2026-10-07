import type { ThreadGoal, ThreadGoalUpdateRequest } from "../api/client";
import type { ChatSnapshot } from "../mastra/client";

// Both views come from their public contracts; native goal usage is evaluation-based.
export type GoalView = ThreadGoal | NonNullable<ChatSnapshot["goal"]>;
export type GoalController = {
  goal: GoalView | null;
  ready: boolean;
  pending: boolean;
  error: string | null;
  supportsTokenBudget?: boolean;
  update: (request: ThreadGoalUpdateRequest) => Promise<unknown>;
  clear: () => Promise<unknown>;
  resetError: () => void;
  reload: () => void;
};
