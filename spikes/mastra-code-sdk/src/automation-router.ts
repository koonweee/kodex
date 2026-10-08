import { watchNativeRows } from './native-watch.js';
import { os } from '@orpc/server';
import { createAutomationService, validAutomationCreate, validAutomationId, validAutomationPatch, type AutomationCreate, type AutomationPatch } from './automation-service.js';
import { inputSchema } from './rpc-input.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identity = inputSchema<{ id: string }>(value => object(value) && Object.keys(value).length === 1 && validAutomationId(value.id));
const createInput = inputSchema<AutomationCreate>(validAutomationCreate);
const updateInput = inputSchema<{ id: string; patch: AutomationPatch }>(value => object(value)
  && Object.keys(value).length === 2 && validAutomationId(value.id) && validAutomationPatch(value.patch));
export function createAutomationRouter(service: ReturnType<typeof createAutomationService>) {
  return {
    watchAutomations: os.handler(({ signal }) => watchNativeRows(() => service.list(), signal)),
    watchAutomationRuns: os.input(identity).handler(({ input, signal }) => watchNativeRows(() => service.runs(input), signal)),
    listAutomations: os.handler(() => service.list()),
    createAutomation: os.input(createInput).handler(({ input }) => service.create(input)),
    updateAutomation: os.input(updateInput).handler(({ input }) => service.update(input)),
    pauseAutomation: os.input(identity).handler(({ input }) => service.pause(input)),
    resumeAutomation: os.input(identity).handler(({ input }) => service.resume(input)),
    deleteAutomation: os.input(identity).handler(({ input }) => service.remove(input)),
    listAutomationRuns: os.input(identity).handler(({ input }) => service.runs(input)),
  };
}
