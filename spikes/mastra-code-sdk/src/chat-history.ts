import type { ProjectRuntime } from './runtime.js';

type HistoryController = Pick<ProjectRuntime['controller'], 'queryThreadMessages'>;
type NativeQuery = Parameters<HistoryController['queryThreadMessages']>[0];
export type NativeHistoryMessage = Awaited<ReturnType<HistoryController['queryThreadMessages']>>['messages'][number];
export type HistoryTarget = Pick<NativeQuery, 'threadId' | 'resourceId'>;
export interface HistoryRequest { earliest?: string; older?: boolean }
export interface HistoryBoundary { earliest: string | null; hasOlder: boolean }
export interface ChatHistory { messages: NativeHistoryMessage[]; history: HistoryBoundary }

/**
 * Stateless native reads: retain a pane's earliest timestamp, never its transcript.
 * Initial/older discovery uses the newest page, then an inclusive range completes
 * the boundary bucket. Ties and the growing loaded range can exceed pageSize.
 * Native LibSQL still counts these reads; the public controller does not forward
 * includeTotal. No offsets are stitched across writes and IDs imply no chronology.
 */
export async function readChatHistory(
  controller: HistoryController,
  target: HistoryTarget,
  request: HistoryRequest = {},
  signal?: AbortSignal,
  pageSize = 40,
): Promise<ChatHistory> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('History page size must be a positive integer.');
  let earliest = request.earliest === undefined ? undefined : new Date(request.earliest);
  if (earliest && !Number.isFinite(earliest.getTime())) throw new Error('Invalid history boundary.');
  const query = async (input: Omit<NativeQuery, 'threadId' | 'resourceId'>) => {
    signal?.throwIfAborted();
    const result = await controller.queryThreadMessages({ ...target, ...input, page: 0 });
    signal?.throwIfAborted();
    return result.messages;
  };

  if (!earliest || request.older) {
    const page = await query({
      perPage: pageSize,
      orderBy: { field: 'createdAt', direction: 'DESC' },
      ...(earliest && { filter: { dateRange: { end: earliest, endExclusive: true } } }),
    });
    if (page.length) earliest = new Date(Math.min(...page.map(message => message.createdAt.getTime())));
  }
  if (!earliest) return { messages: [], history: { earliest: null, hasOlder: false } };

  // Inclusive lower bound preserves every visible row on new arrivals and picks
  // up delayed persistence anywhere inside the loaded range, including ties.
  const messages = await query({
    perPage: false,
    orderBy: { field: 'createdAt', direction: 'ASC' },
    filter: { dateRange: { start: earliest } },
  });
  const older = await query({
    perPage: 1,
    orderBy: { field: 'createdAt', direction: 'DESC' },
    filter: { dateRange: { end: earliest, endExclusive: true } },
  });
  return { messages, history: { earliest: earliest.toISOString(), hasOlder: older.length > 0 } };
}
