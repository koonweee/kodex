import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { PublicSchema } from '@mastra/core/schema';

export const AUTOMATION_WORKFLOW_ID = 'kodex-automation-dispatch';
export interface AutomationWorkflowInput { name: string; prompt: string; targetThreadId: string }
export type AutomationDelivery = (input: { targetThreadId: string; prompt: string; resourceId?: string }) => Promise<{ accepted: true }>;
export const AUTOMATION_INPUT_LIMITS = { name: 256, prompt: 100_000, targetThreadId: 256 };
export function readAutomationWorkflowInput(value: unknown): AutomationWorkflowInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || !Object.entries(AUTOMATION_INPUT_LIMITS).every(([key, limit]) =>
    typeof fields[key] === 'string' && Boolean(fields[key].trim()) && fields[key].length <= limit && !fields[key].includes('\0'))) return null;
  return { name: fields.name as string, prompt: fields.prompt as string, targetThreadId: fields.targetThreadId as string };
}
/** The workflow owns only dispatch. Native Session admission owns execution,
 * tools, permissions, active joining and any eventual response or suspension. */
export function createAutomationWorkflow(deliver: AutomationDelivery) {
  const inputSchema = { type: 'object', additionalProperties: false, required: ['name', 'prompt', 'targetThreadId'],
    properties: Object.fromEntries(Object.entries(AUTOMATION_INPUT_LIMITS).map(([key, maxLength]) => [key, { type: 'string', minLength: 1, maxLength, pattern: '\\S' }])) } satisfies PublicSchema;
  const outputSchema = { type: 'object', additionalProperties: false, required: ['accepted'],
    properties: { accepted: { type: 'boolean', const: true } } } satisfies PublicSchema;
  const dispatch = createStep({ id: 'dispatch-chat-input', inputSchema, outputSchema,
    execute: async ({ inputData, resourceId }) => {
      const input = readAutomationWorkflowInput(inputData);
      if (!input) throw new Error('Invalid automation input');
      return deliver({ targetThreadId: input.targetThreadId, prompt: input.prompt, ...(resourceId !== undefined && { resourceId }) });
    },
  });
  return createWorkflow({ id: AUTOMATION_WORKFLOW_ID, inputSchema, outputSchema }).then(dispatch).commit();
}
