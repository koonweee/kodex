import { Alert, Button, Group, Modal, NumberInput, Stack, Text, Textarea } from "@mantine/core";
import { Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { ThreadGoal, ThreadGoalUpdateRequest } from "../api/client";
import { errorMessageFrom } from "../shared/values";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { goalStatusLabel, goalUsageLabel } from "./goalPresentation";
import "./goals.css";

type GoalModalProps = {
  goal: ThreadGoal | null;
  pending: boolean;
  error: string | null;
  ready?: boolean;
  onReload?: () => void;
  onClose: () => void;
  onUpdate: (request: ThreadGoalUpdateRequest) => Promise<unknown>;
  onClear: () => Promise<unknown>;
};

export function GoalModal({ goal, pending, error, ready = true, onReload, onClose, onUpdate, onClear }: GoalModalProps) {
  // The editor retains its opened baseline; native refills never replace an unsaved draft.
  const [initialized, setInitialized] = useState(ready);
  const [baseline, setBaseline] = useState(goal);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [tokenBudget, setTokenBudget] = useState<number | string>(goal?.tokenBudget ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [reviewRequested, setReviewRequested] = useState(false);
  useEffect(() => {
    if (initialized || !ready) return;
    setBaseline(goal);
    setObjective(goal?.objective ?? "");
    setTokenBudget(goal?.tokenBudget ?? "");
    setInitialized(true);
  }, [goal, initialized, ready]);
  const cleared = baseline !== null && goal === null;
  const validBudget = tokenBudget === "" || (typeof tokenBudget === "number" && Number.isSafeInteger(tokenBudget) && tokenBudget > 0);
  const nextObjective = objective.trim();
  const nextBudget = tokenBudget === "" ? null : Number(tokenBudget);
  const changedObjective = nextObjective !== (baseline?.objective ?? "");
  const changedBudget = nextBudget !== (baseline?.tokenBudget ?? null);
  const latestChanges: ("objective" | "tokenBudget")[] = [];
  if (changedObjective && goal?.objective !== baseline?.objective && goal?.objective !== nextObjective) latestChanges.push("objective");
  if (changedBudget && (goal?.tokenBudget ?? null) !== (baseline?.tokenBudget ?? null) && (goal?.tokenBudget ?? null) !== nextBudget) latestChanges.push("tokenBudget");
  if (!baseline && goal && !latestChanges.includes("objective")) latestChanges.push("objective");
  const conflicts = reviewRequested ? latestChanges : [];


  async function run(operation: () => Promise<unknown>, close = false) {
    setLocalError(null);
    try {
      await operation();
      if (close) onClose();
    } catch (failure) {
      setLocalError(errorMessageFrom(failure));
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (pending || !ready || cleared || !objective.trim() || !validBudget) return;
    const patch: ThreadGoalUpdateRequest = {};
    if (changedObjective) patch.objective = nextObjective;
    if (changedBudget) patch.tokenBudget = nextBudget;
    if (latestChanges.length > 0) {
      setReviewRequested(true);
      return;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    void run(() => onUpdate(patch), true);
  }

  return (
    <Modal opened onClose={onClose} title="Goal" centered size="md" closeButtonProps={{ "aria-label": "Close goal" }}>
      <form onSubmit={save}>
        <Stack gap="md" className="kodex-goal-modal">
          {goal ? (
            <Group justify="space-between" gap="xs">
              <Text size="sm" fw={600}>{goalStatusLabel(goal)}</Text>
              <Text size="xs" c="dimmed">{goalUsageLabel(goal)}</Text>
            </Group>
          ) : null}
          <Textarea label="Objective" autosize minRows={3} maxRows={8} required value={objective}
            disabled={pending || !ready || cleared} onChange={(event) => setObjective(event.currentTarget.value)} />
          <NumberInput label="Token budget" role="spinbutton" aria-valuemin={1} aria-valuemax={Number.MAX_SAFE_INTEGER}
            aria-valuenow={typeof tokenBudget === "number" ? tokenBudget : undefined} value={tokenBudget} onChange={setTokenBudget}
            min={1} max={Number.MAX_SAFE_INTEGER} allowDecimal={false} allowNegative={false} hideControls disabled={pending || !ready || cleared} />
          {cleared ? <Alert color="red">This goal was cleared.</Alert> : null}
          {conflicts.length > 0 && !cleared ? (
            <Alert color="orange" title="Goal changed">
              {conflicts.map((conflict) => <Text key={conflict} size="sm">{conflict === "objective" ? `Objective: ${goal?.objective}` : `Token budget: ${goal?.tokenBudget?.toLocaleString() ?? "None"}`}</Text>)}
              <Button size="compact-sm" variant="subtle" onClick={() => { if (objective.trim() === (baseline?.objective ?? "")) setObjective(goal?.objective ?? "");
                if ((tokenBudget === "" ? null : Number(tokenBudget)) === (baseline?.tokenBudget ?? null)) setTokenBudget(goal?.tokenBudget ?? "");
                setBaseline(goal); setReviewRequested(false); }}>
                Keep my edits
              </Button>
            </Alert>
          ) : null}
          {localError || error ? <Alert color="red">{localError ?? error}{onReload ? <Button variant="subtle" size="compact-sm" onClick={onReload}>Reload goal</Button> : null}</Alert> : null}
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap="xs">
              {goal ? (
                <>
                  <AdaptiveIconButton label="Clear goal" color="red" disabled={pending || !ready}
                    onClick={() => void run(onClear, true)}><Trash2 /></AdaptiveIconButton>
                  {goal.status !== "complete" ? <Button variant="subtle" disabled={pending || !ready}
                    leftSection={goal.status === "active" ? <Pause size={16} /> : <Play size={16} />}
                    onClick={() => void run(() => onUpdate({ status: goal.status === "active" ? "paused" : "active" }))}>
                    {goal.status === "active" ? "Pause goal" : "Resume goal"}
                  </Button> : null}
                </>
              ) : null}
            </Group>
            <Button type="submit" disabled={pending || !ready || cleared || !objective.trim() || !validBudget} loading={pending}>Save goal</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
