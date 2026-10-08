import { randomUUID } from 'node:crypto';
import { MastraError } from '@mastra/core/error';
import { toWorkflowSchedule, type WorkflowSchedule, type AnySchedule } from '@mastra/core/schedules';
import { AUTOMATION_INPUT_LIMITS, AUTOMATION_WORKFLOW_ID, readAutomationWorkflowInput, type AutomationWorkflowInput } from './automation-workflow.js';
import type { AnyWorkflow } from '@mastra/core/workflows';
import { ORPCError } from '@orpc/server';
import type { ProjectRuntime } from './runtime.js';

export interface AutomationServiceOptions {
  runtimes(): Promise<ProjectRuntime[]>;
  resolveTarget(chatId: string): Promise<{ runtime: ProjectRuntime; thread: { id: string; resourceId: string } }>;
}
export interface AutomationCreate { name: string; prompt: string; targetThreadId: string; cron: string; timezone: string }
export type AutomationPatch = Partial<AutomationCreate>;
export interface Automation {
  id: string; name: string; prompt: string; targetThreadId: string; cron: string; timezone?: string;
  status: WorkflowSchedule['status']; nextFireAt: number; lastFireAt?: number; createdAt: number; updatedAt: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const limits = { ...AUTOMATION_INPUT_LIMITS, cron: 256, timezone: 256 };
const text = (value: unknown, limit: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit && !value.includes('\0');
export const validAutomationId = (value: unknown) => text(value, 256);
export function validAutomationCreate(value: unknown): value is AutomationCreate {
  return object(value) && Object.keys(value).length === Object.keys(limits).length
    && Object.entries(limits).every(([key, limit]) => text(value[key], limit));
}
export function validAutomationPatch(value: unknown): value is AutomationPatch {
  return object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, field]) =>
    Object.hasOwn(limits, key) && text(field, limits[key as keyof typeof limits]));
}
const missing = () => new ORPCError('NOT_FOUND', { message: 'Automation was not found.' });
type OwnedSchedule = WorkflowSchedule & { resourceId: string; inputData: AutomationWorkflowInput };
function owned(row: AnySchedule | null): row is OwnedSchedule {
  return row !== null && row.workflowId === AUTOMATION_WORKFLOW_ID && row.metadata?.kodexAutomation === 1
    && typeof row.resourceId === 'string' && Boolean(row.resourceId.trim()) && !row.resourceId.includes('\0')
    && readAutomationWorkflowInput(row.inputData) !== null;
}
function project(row: OwnedSchedule): Automation {
  return { id: row.id, ...row.inputData, cron: row.cron,
    ...(row.timezone !== undefined && { timezone: row.timezone }), status: row.status, nextFireAt: row.nextFireAt,
    ...(row.lastFireAt !== undefined && { lastFireAt: row.lastFireAt }), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
async function native<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof MastraError && error.id === 'SCHEDULES_INVALID_TIMING') {
      throw new ORPCError('BAD_REQUEST', { message: 'Enter a valid cron expression and IANA timezone with a future occurrence.' });
    }
    if (error instanceof MastraError && error.id === 'SCHEDULES_COMPLETED') {
      throw new ORPCError('CONFLICT', { message: 'This native schedule is completed. Change its calendar to schedule future work.' });
    }
    if (error instanceof MastraError && error.id === 'SCHEDULES_NOT_FOUND') throw missing();
    throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Native automation storage could not be read or changed.' });
  }
}

/** Native schedules own definitions, calendar claims and trigger history. This
 * service filters product-owned workflow rows and never creates a second store. */
export function createAutomationService(options: AutomationServiceOptions) {
  // Native workflow inputData is replaced as one object. Serialize its sparse
  // read/merge/write with other mutations; never hold this gate for model work.
  const gates = new Map<string, Promise<void>>();
  function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const run = (gates.get(id) ?? Promise.resolve()).then(operation);
    const tail = run.then(() => {}, () => {});
    gates.set(id, tail);
    void tail.then(() => { if (gates.get(id) === tail) gates.delete(id); });
    return run;
  }
  async function locate(id: string) {
    if (!validAutomationId(id)) throw new ORPCError('BAD_REQUEST', { message: 'Provide an automation identity.' });
    const matches = (await Promise.all((await options.runtimes()).map(async runtime => {
      const row = await runtime.mastra.schedules.get(id);
      return owned(row) && row.id === id ? { runtime, row } : null;
    }))).filter(match => match !== null);
    if (matches.length === 0) throw missing();
    if (matches.length !== 1) throw new ORPCError('CONFLICT', { message: 'Automation identity is ambiguous.' });
    return matches[0]!;
  }
  function mutate(id: string, operation: (runtime: ProjectRuntime) => Promise<AnySchedule>) {
    return serial(id, async () => {
      const { runtime } = await locate(id);
      const row = await operation(runtime);
      if (!owned(row)) throw missing();
      return project(row);
    });
  }
  return {
    list(): Promise<Automation[]> {
      return native(async () => (await Promise.all((await options.runtimes()).map(async runtime => {
        // One native read includes completed schedules without composing
        // status queries that can overlap a native lifecycle transition.
        const store = await runtime.mastra.getStorage()?.getStore('schedules');
        if (!store) throw new Error('Missing schedules storage');
        const rows = (await store.listSchedules({ workflowId: AUTOMATION_WORKFLOW_ID })).map(toWorkflowSchedule);
        return rows.filter(owned).map(project);
      }))).flat().sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)));
    },
    create(input: AutomationCreate): Promise<Automation> {
      return native(async () => {
        if (!validAutomationCreate(input)) throw new ORPCError('BAD_REQUEST', { message: 'Provide a name, prompt, target chat, cron expression and timezone.' });
        const { runtime, thread } = await options.resolveTarget(input.targetThreadId);
        if (thread.id !== input.targetThreadId || !validAutomationId(thread.resourceId)) throw missing();
        const inputData: AutomationWorkflowInput = { name: input.name.trim(), prompt: input.prompt, targetThreadId: thread.id };
        const row = await runtime.mastra.schedules.create({ id: randomUUID(), workflowId: AUTOMATION_WORKFLOW_ID,
          inputData, resourceId: thread.resourceId, cron: input.cron, timezone: input.timezone, metadata: { kodexAutomation: 1 } });
        if (!owned(row)) throw missing();
        return project(row);
      });
    },
    update({ id, patch }: { id: string; patch: AutomationPatch }): Promise<Automation> {
      return native(async () => {
        if (!validAutomationPatch(patch)) throw new ORPCError('BAD_REQUEST', { message: 'Provide a nonempty sparse automation edit.' });
        return serial(id, async () => {
          const { runtime, row } = await locate(id);
          let resourceId = row.resourceId;
          if (patch.targetThreadId !== undefined) {
            const target = await options.resolveTarget(patch.targetThreadId);
            if (target.thread.id !== patch.targetThreadId || !validAutomationId(target.thread.resourceId)) throw missing();
            resourceId = target.thread.resourceId;
          }
          const inputData = { ...row.inputData,
            ...(patch.name !== undefined && { name: patch.name.trim() }),
            ...(patch.prompt !== undefined && { prompt: patch.prompt }),
            ...(patch.targetThreadId !== undefined && { targetThreadId: patch.targetThreadId }) };
          const changed = await runtime.mastra.schedules.update(id, { inputData, resourceId,
            ...(patch.cron !== undefined && { cron: patch.cron }), ...(patch.timezone !== undefined && { timezone: patch.timezone }) });
          if (!owned(changed)) throw missing();
          return project(changed);
        });
      });
    },
    pause({ id }: { id: string }): Promise<Automation> { return native(() => mutate(id, runtime => runtime.mastra.schedules.pause(id))); },
    resume({ id }: { id: string }): Promise<Automation> { return native(() => mutate(id, runtime => runtime.mastra.schedules.resume(id))); },
    remove({ id }: { id: string }): Promise<{ id: string }> {
      return native(() => serial(id, async () => { const { runtime } = await locate(id); await runtime.mastra.schedules.delete(id); return { id }; }));
    },
    runs({ id }: { id: string }) {
      return native(async () => {
        const { runtime } = await locate(id), store = await runtime.mastra.getStorage()?.getStore('schedules');
        if (!store) throw new Error('Missing schedules storage');
        const workflow: AnyWorkflow = runtime.mastra.getWorkflow(AUTOMATION_WORKFLOW_ID);
        const history = [];
        // Bounded sequential reads expose native dispatch status only. A
        // successful dispatch is input acceptance, not model completion.
        for (const row of await store.listTriggers(id, { limit: 100 })) {
          // Status is always returned; select only the tiny dispatch result to
          // omit native step/error/payload expansion from this public read.
          const run = row.runId === null ? null : await workflow.getWorkflowRunById(row.runId, { withNestedWorkflows: false, fields: ['result'] });
          history.push({
            ...(row.id !== undefined && { id: row.id }), scheduleId: row.scheduleId, runId: row.runId,
            scheduledFireAt: row.scheduledFireAt, actualFireAt: row.actualFireAt, outcome: row.outcome,
            ...(row.triggerKind !== undefined && { triggerKind: row.triggerKind }),
            ...(run?.status !== undefined && { deliveryStatus: run.status }),
            ...((row.error || run?.status === 'failed') && { error: 'Native schedule delivery reported an error. Inspect the local backend logs for details.' }),
          });
        }
        return history;
      });
    },
  };
}
export type AutomationService = ReturnType<typeof createAutomationService>;
