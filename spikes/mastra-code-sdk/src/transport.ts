import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventPublisher, eventIterator, os, type as schemaType } from '@orpc/server';
import { RPCHandler } from '@orpc/server/node';
import type { NativeSession } from './runtime.js';
import type { ChatHistory, HistoryBoundary, HistoryRequest } from './chat-history.js';

type Display = ReturnType<NativeSession['displayState']['get']>;
type Messages = Awaited<ReturnType<NativeSession['thread']['listActiveMessages']>>;
export interface SessionSnapshot {
  epoch: string;
  /** Process-local event coverage, not a native database commit version. */
  revision: number;
  display: Display;
  messages: Messages;
  history: HistoryBoundary;
}

/** Compatibility proof, not the production protocol: SDK owns all conversation state.
 * oRPC buffers a single invalidation per consumer; every update is a fresh full snapshot.
 */
export function createSessionProjection(session: NativeSession, readHistory?: (request: HistoryRequest, signal?: AbortSignal) => Promise<ChatHistory>) {
  const epoch = randomUUID();
  let revision = 0;
  const lifetime = new AbortController();
  const publisher = new EventPublisher<{ changed: number }>({ maxBufferedEvents: 1 });
  const unsubscribe = session.subscribe(event => {
    // Native text changes precede its coalesced display notification. Fence every
    // event, while publishing only the SDK's batched display invalidations.
    revision++;
    if (event.type === 'display_state_changed') publisher.publish('changed', revision);
  });

  async function snapshot(signal?: AbortSignal, request: HistoryRequest = {}): Promise<SessionSnapshot> {
    // A history read can overlap a native mutation. Retry rather than claim a
    // newer display revision also covers an older history response. This
    // cannot fence native database writes that have no corresponding event.
    for (;;) {
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const startedAt = revision;
      const history = readHistory ? await readHistory(request, signal) : { messages: await session.thread.listActiveMessages(), history: { earliest: null, hasOlder: false } };
      signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (startedAt !== revision) continue;
      return structuredClone({ epoch, revision, display: session.displayState.get(), ...history });
    }
  }
  return {
    snapshot,
    async *watch(signal?: AbortSignal, request: HistoryRequest = {}): AsyncGenerator<SessionSnapshot, void> {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const changes = publisher.subscribe('changed', { signal: combined });
      try {
        let last = await snapshot(combined, request);
        yield last;
        for await (const current of changes) {
          if (current <= last.revision) continue;
          last = await snapshot(combined, last.history.earliest ? { earliest: last.history.earliest } : {});
          yield last;
        }
      } finally {
        await changes.return();
      }
    },
    dispose() { lifetime.abort(); unsubscribe(); },
  };
}

function projectionRouter(projection: ReturnType<typeof createSessionProjection>) {
  return {
    snapshot: os.output(schemaType<SessionSnapshot>()).handler(({ signal }) => projection.snapshot(signal)),
    watch: os.output(eventIterator(schemaType<SessionSnapshot>())).handler(({ signal }) => projection.watch(signal)),
  };
}
export type ProjectionRouter = ReturnType<typeof projectionRouter>;

/** Local/VPN spike only: no authentication or production routing. */
export async function serveProjection(projection: ReturnType<typeof createSessionProjection>) {
  const handler = new RPCHandler(projectionRouter(projection));
  const server = createServer((request, response) => {
    void handler.handle(request, response).then(({ matched }) => {
      if (!matched) { response.statusCode = 404; response.end(); }
    }).catch(() => { response.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No projection server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
