import { os } from '@orpc/server';
import { inputSchema } from './rpc-input.js';
import type { PushService } from './push-service.js';
import type { PushDeviceInput } from './push-store.js';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const string = (value: unknown, max = 4096): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const endpoint = (value: unknown) => { if (!string(value, 8192)) return false; try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const deviceInput = inputSchema<PushDeviceInput>(value => object(value) && only(value, ['endpoint', 'keys', 'userAgent']) && endpoint(value.endpoint)
  && object(value.keys) && only(value.keys, ['p256dh', 'auth']) && string(value.keys.p256dh) && string(value.keys.auth)
  && (value.userAgent === undefined || value.userAgent === null || typeof value.userAgent === 'string' && value.userAgent.length <= 4096));
const endpointInput = inputSchema<{ endpoint: string }>(value => object(value) && only(value, ['endpoint']) && endpoint(value.endpoint));
const removeInput = inputSchema<{ subscriptionId: string }>(value => object(value) && only(value, ['subscriptionId']) && string(value.subscriptionId));
/** The gateway owns lazy construction; merely mounting preferences routes opens no store. */
export function createPushRouter(getService: () => Promise<PushService>) {
  return {
    status: os.handler(async () => (await getService()).status()),
    current: os.input(endpointInput).handler(async ({ input }) => (await getService()).current(input)),
    upsert: os.input(deviceInput).handler(async ({ input }) => (await getService()).upsert(input)),
    disable: os.input(endpointInput).handler(async ({ input }) => (await getService()).disable(input)),
    remove: os.input(removeInput).handler(async ({ input }) => (await getService()).remove(input)),
    test: os.handler(async () => (await getService()).test()),
  };
}
