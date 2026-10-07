import { Box, Text } from "@mantine/core";
import { AlertCircle, Pause, Pencil, Play, Target, Trash2 } from "lucide-react";

import type { ThreadGoal } from "../api/client";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { goalStatusLabel, goalUsageLabel } from "./goalPresentation";
import "./goals.css";

export type GoalControls = {
  goal: ThreadGoal | null;
  ready: boolean;
  pending: boolean;
  compact: boolean;
  error: string | null;
  onReload: () => void;
  onOpen: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
};

export function GoalBar({ controls }: { controls: GoalControls }) {
  const { goal, pending, onOpen, onToggleStatus } = controls;
  if (!goal) return null;
  return (
    <Box className="kodex-goal-bar" aria-label="Chat goal" role="region" data-goal-status={goal.status}>
      <Target size={17} aria-hidden="true" />
      <Box className="kodex-goal-bar-summary">
        <Text className="kodex-goal-objective" title={goal.objective} size="sm">{goal.objective}</Text>
        <Text className="kodex-goal-usage" size="xs" c="dimmed">{goalStatusLabel(goal)} · {goalUsageLabel(goal)}</Text>
      </Box>
      <AdaptiveIconButton label="Delete goal" disabled={pending || !controls.ready} onClick={controls.onDelete}><Trash2 /></AdaptiveIconButton>
      <AdaptiveIconButton label={`Manage goal: ${goalStatusLabel(goal)}`} onClick={onOpen} tooltip="Edit goal"><Pencil /></AdaptiveIconButton>
      {goal.status !== "complete" ? <AdaptiveIconButton label={goal.status === "active" ? "Pause goal" : "Resume goal"} disabled={pending || !controls.ready} onClick={onToggleStatus}>
        {goal.status === "active" ? <Pause /> : <Play />}
      </AdaptiveIconButton> : null}
    </Box>
  );
}

export function GoalButton({ controls }: { controls: GoalControls }) {
  const { goal, error, onOpen } = controls;
  if (!goal) return error ? <AdaptiveIconButton color="red" label="Goal unavailable" onClick={onOpen}><AlertCircle /></AdaptiveIconButton> : null;
  return (
    <AdaptiveIconButton iconColor="inherit" className="kodex-goal-icon" label={`Manage goal: ${goalStatusLabel(goal)}`}
      tooltip={<span className="kodex-goal-tooltip">Goal: {goal.objective}</span>} onClick={onOpen} data-goal-status={goal.status}>
      <Target />
    </AdaptiveIconButton>
  );
}
