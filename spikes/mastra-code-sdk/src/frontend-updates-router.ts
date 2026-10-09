import { os } from '@orpc/server';
import type { FrontendUpdates } from './frontend-updates.js';
import { inputSchema } from './rpc-input.js';

const updateInput = inputSchema<{ revision: string }>(value => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === 1 && 'revision' in value && typeof value.revision === 'string'
  && value.revision.trim().length > 0 && value.revision.length <= 256);
const host = os.$context<{ frontendUpdates: FrontendUpdates }>();
/** Shared route definitions; the HTTP host owns their context and lifetime. */
export const frontendUpdateRouter = {
  frontendUpdated: host.input(updateInput).handler(({ input, context }) => context.frontendUpdates.publish(input.revision)),
  watchFrontendUpdates: host.handler(({ signal, context }) => context.frontendUpdates.watch(signal)),
};
