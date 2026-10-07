import { useEffect, useRef, useState } from 'react';
import type { GoalController } from '../goals/controller';
import type { ThreadGoalUpdateRequest } from '../api/client';
import { errorMessageFrom } from '../shared/values';
import { mastraClient, type ChatSnapshot } from './client';

export function useMastraGoal(chatId: string | null, snapshot: ChatSnapshot | null, ready: boolean, onReload?: () => void): GoalController {
  const scope = JSON.stringify([chatId, snapshot?.epoch]);
  const active = useRef(scope); active.current = scope;
  const generation = useRef(0);
  const running = useRef<{ scope: string; token: number } | null>(null);
  const [operation, setOperation] = useState<{ scope: string; busy: boolean; error: string | null } | null>(null);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [scope]);
  async function mutate(action: () => Promise<unknown>) {
    if (!chatId || !snapshot || !ready) throw new Error('Load the chat before changing its goal.');
    if (running.current?.scope === scope) throw new Error('A goal change is already pending.');
    const token = generation.current;
    running.current = { scope, token };
    setOperation({ scope, busy: true, error: null });
    try {
      const result = await action();
      // Acceptance never overwrites the canonical openChat/watchChat projection.
      if (active.current === scope && generation.current === token) {
        setOperation({ scope, busy: false, error: null });
        onReload?.();
      }
      return result;
    } catch (failure) {
      if (active.current === scope && generation.current === token) setOperation({ scope, busy: false, error: errorMessageFrom(failure) });
      throw failure;
    } finally { if (running.current?.scope === scope && running.current.token === token) running.current = null; }
  }
  return {
    goal: snapshot?.goal ?? null,
    ready: Boolean(chatId && snapshot && ready),
    pending: operation?.scope === scope && operation.busy,
    error: operation?.scope === scope ? operation.error : null,
    supportsTokenBudget: false,
    update: (request: ThreadGoalUpdateRequest) => mutate(() => {
      if (request.tokenBudget !== undefined) throw new Error('Native goals do not support token budgets.');
      if (request.objective === null || (request.status !== undefined && request.status !== 'active' && request.status !== 'paused')) {
        throw new Error('Provide a nonempty objective or an active/paused status.');
      }
      const patch: Parameters<typeof mastraClient.updateGoal>[0]['patch'] = {};
      if (request.objective !== undefined) patch.objective = request.objective;
      if (request.status !== undefined) patch.status = request.status;
      return mastraClient.updateGoal({ chatId: chatId!, patch });
    }),
    clear: () => mutate(() => mastraClient.clearGoal({ chatId: chatId! })),
    resetError: () => setOperation(current => current?.busy ? current : null),
    reload: () => { setOperation(current => current?.busy ? current : null); onReload?.(); },
  };
}
