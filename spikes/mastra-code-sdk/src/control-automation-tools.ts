import type { PublicSchema } from '@mastra/core/schema';
import { AUTOMATION_INPUT_LIMITS } from './automation-workflow.js';
import type { AutomationCreate, AutomationPatch } from './automation-service.js';
import { createControlToolFactory, type ControlOptions } from './control-tools.js';

const text = (maxLength: number) => ({ type: 'string' as const, minLength: 1, maxLength, pattern: '\\S' });
const identity = { automationId: text(256) };
const fields = { ...Object.fromEntries(Object.entries(AUTOMATION_INPUT_LIMITS).map(([key, limit]) => [key, text(limit)])),
  cron: text(256), timezone: text(256) };
type JsonSchema = Extract<PublicSchema, { type?: unknown }>;
const schema = (properties: NonNullable<JsonSchema['properties']>, required: string[], minProperties?: number): PublicSchema =>
  ({ type: 'object', properties, required, additionalProperties: false, ...(minProperties !== undefined && { minProperties }) });

/** Existing native workflow schedules, using the same ordinary-origin Control
 * guard as chat tools. No scheduler, receipts, retries or model completion gate. */
export function createControlAutomationTools(options: ControlOptions) {
  const tool = createControlToolFactory(options);
  return {
    create_automation: tool<AutomationCreate & { enabled?: boolean }>('create_automation',
      'Create a native cron/IANA timezone automation. Defaults to paused for review; enabled:true explicitly starts its calendar. This does not run it now.',
      schema({ ...fields, enabled: { type: 'boolean' } }, Object.keys(fields)),
      ({ enabled = false, ...input }, service) => service.automations.create(input, { status: enabled ? 'active' : 'paused' })),
    validate_automation: tool<AutomationCreate>('validate_automation',
      'Validate a native automation target and cron/IANA timezone without creating a schedule, loading its chat or sending input. nextFireAt is the native next calendar occurrence, not a reservation.',
      schema(fields, Object.keys(fields)), (input, service) => service.automations.validate(input)),
    list_automations: tool<{ threadId?: string }>('list_automations', 'List product-owned native automations, including completed calendars. Optionally filter by target chat.',
      schema({ threadId: text(256) }, []), async ({ threadId }, service) => ({ automations: (await service.automations.list()).filter(row => threadId === undefined || row.targetThreadId === threadId) })),
    get_automation: tool<{ automationId: string }>('get_automation', 'Read one product-owned native automation without loading its target chat.',
      schema(identity, ['automationId']), ({ automationId }, service) => service.automations.get({ id: automationId })),
    update_automation: tool<AutomationPatch & { automationId: string }>('update_automation',
      'Apply only supplied native automation fields. Use pause_automation/resume_automation to change calendar status.',
      schema({ ...identity, ...fields }, ['automationId'], 2),
      ({ automationId, ...patch }, service) => service.automations.update({ id: automationId, patch })),
    delete_automation: tool<{ automationId: string }>('delete_automation', 'Delete a native automation definition. This does not interrupt an already admitted chat run.',
      schema(identity, ['automationId']), ({ automationId }, service) => service.automations.remove({ id: automationId })),
    run_automation_now: tool<{ automationId: string }>('run_automation_now',
      'Dispatch a native automation once, even while paused, without changing its calendar. The acknowledgment is dispatch, not model completion. Inspect an uncertain result; never automatically retry.',
      schema(identity, ['automationId']), ({ automationId }, service) => service.automations.run({ id: automationId })),
    pause_automation: tool<{ automationId: string }>('pause_automation', 'Pause the native calendar without interrupting already admitted chat work.',
      schema(identity, ['automationId']), ({ automationId }, service) => service.automations.pause({ id: automationId })),
    resume_automation: tool<{ automationId: string }>('resume_automation', 'Resume the native calendar. This does not run it immediately.',
      schema(identity, ['automationId']), ({ automationId }, service) => service.automations.resume({ id: automationId })),
  };
}
