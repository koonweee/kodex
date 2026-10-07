import { createGoalReminderSignal } from '@mastra/code-sdk/goal-signal';
import { getGoalActivityDurationMs, type Agent } from '@mastra/core/agent';
import { ORPCError } from '@orpc/server';
import type { NativeSession } from './runtime.js';
import { captureChatFastRequestContext } from './chat-fast.js';

export interface NativeGoal {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'done';
  evaluationsUsed: number;
  timeUsedSeconds: number;
  pausedReason: string | null;
}
export interface GoalPatch { objective?: string; status?: 'active' | 'paused' }
type Objective = NonNullable<Awaited<ReturnType<Agent['getObjective']>>>;
const unavailable = () => new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Native goal storage is unavailable.' });

function validate(value: unknown): asserts value is GoalPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ORPCError('BAD_REQUEST', { message: 'Invalid goal update.' });
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => key !== 'objective' && key !== 'status')
    || ('objective' in patch && (typeof patch.objective !== 'string' || !patch.objective.trim()))
    || ('status' in patch && patch.status !== 'active' && patch.status !== 'paused')) {
    throw new ORPCError('BAD_REQUEST', { message: 'Provide a nonempty objective or an active/paused status.' });
  }
}

/** Native objective state and evaluation stay native-owned. This gate only keeps
 * public commands from interleaving a replacement and its paused restoration.
 * Reminder admission is awaited; native execution completion is never awaited.
 */
export function createChatGoals() {
  const tails = new WeakMap<NativeSession, Promise<void>>();
  function serial<T>(session: NativeSession, command: () => Promise<T>): Promise<T> {
    const result = (tails.get(session) ?? Promise.resolve()).then(command);
    tails.set(session, result.then(() => {}, () => {}));
    return result;
  }
  function target(session: NativeSession) {
    const threadId = session.thread.getId();
    if (!threadId) throw new ORPCError('BAD_REQUEST', { message: 'A goal requires an existing chat.' });
    return { threadId, resourceId: session.identity.getResourceId() };
  }
  function identified(record: Objective | undefined): Objective & { id: string } {
    if (!record?.id) throw unavailable();
    return { ...record, id: record.id };
  }
  async function remind(session: NativeSession, record: Objective) {
    const goal = identified(record);
    const requestContext = await captureChatFastRequestContext(session);
    const admission = await session.sendSignal(createGoalReminderSignal({
      id: goal.id, objective: goal.objective, status: goal.status,
      turnsUsed: goal.runsUsed, maxTurns: goal.maxRuns ?? Number.MAX_SAFE_INTEGER,
      judgeModelId: goal.judgeModelId ?? '', startedAt: new Date(goal.startedAt).toISOString(),
    }), { requireDelivery: true, requestContext }).accepted;
    if (admission.action !== 'wake' && admission.action !== 'deliver') {
      throw new ORPCError('CONFLICT', { message: 'The native goal was saved, but its execution reminder was not admitted.' });
    }
  }
  return {
    read(session: NativeSession): Promise<NativeGoal | null> {
      return serial(session, async () => {
        const threadId = session.thread.getId();
        if (!threadId) return null;
        const agent = session.machinery.getAgent();
        const record = await agent.getObjective({ threadId });
        if (!record) return null;
        const goal = identified(record);
        return { id: goal.id, objective: goal.objective, status: goal.status,
          evaluationsUsed: goal.runsUsed,
          timeUsedSeconds: getGoalActivityDurationMs({ agentId: agent.id, threadId,
            objectiveId: goal.id, activeDurationMs: goal.activeDurationMs }) / 1000,
          pausedReason: goal.status === 'paused' ? goal.pausedReason ?? null : null };
      });
    },
    async update(session: NativeSession, patch: GoalPatch): Promise<void> {
      validate(patch);
      // Copy submitted values before admission so callers cannot mutate a waiting command.
      const submitted = { ...patch };
      return serial(session, async () => {
        const ids = target(session);
        const agent = session.machinery.getAgent();
        const current = await agent.getObjective({ threadId: ids.threadId });
        let next: Objective;
        if (submitted.objective !== undefined) {
          // The native configured judge resolver takes precedence at evaluation;
          // this record supplies the session model when that resolver is unset.
          const judgeModelId = session.model.get() || session.mode.resolve().defaultModelId || '';
          next = identified(await agent.setObjective(submitted.objective, { ...ids,
            maxRuns: Number.MAX_SAFE_INTEGER, judgeModelId }));
          // Native replacement supplies a fresh ID and resets its counters/time.
          if ((submitted.status ?? (current?.status === 'paused' ? 'paused' : 'active')) === 'paused') {
            next = identified(await agent.updateObjectiveOptions({ threadId: ids.threadId, status: 'paused' }));
          }
        } else {
          if (!current) throw new ORPCError('NOT_FOUND', { message: 'This chat has no goal.' });
          next = identified(await agent.updateObjectiveOptions({ threadId: ids.threadId, status: submitted.status }));
        }
        if (next.status === 'active') await remind(session, next);
      });
    },
    clear(session: NativeSession): Promise<void> {
      return serial(session, async () => {
        const threadId = session.thread.getId();
        if (threadId) await session.machinery.getAgent().clearObjective({ threadId });
      });
    },
  };
}
