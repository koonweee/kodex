import type { ClientLink } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';

// oRPC's connecting sender does not observe cancellation until after sending.
// Wait here so a canceled call cannot become a new request when the socket opens.
function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (socket.readyState !== WebSocket.CONNECTING) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', opened);
      socket.removeEventListener('close', closed);
      socket.removeEventListener('error', closed);
      signal?.removeEventListener('abort', aborted);
    };
    const opened = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Chat connection closed')); };
    const aborted = () => { cleanup(); reject(signal?.reason); };
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('close', closed, { once: true });
    socket.addEventListener('error', closed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** One multiplexed connection per tab; only future calls reconnect, never writes in flight. */
export function createSocketLink(url: () => string): ClientLink<Record<string, never>> {
  let connection: { socket: WebSocket; link: RPCLink<Record<string, never>> } | undefined;
  return {
    async call(path, input, options) {
      options.signal?.throwIfAborted();
      if (!connection || connection.socket.readyState >= WebSocket.CLOSING) {
        const endpoint = new URL(url());
        endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(endpoint);
        connection = { socket, link: new RPCLink({ websocket: socket }) };
      }
      const current = connection;
      await waitForOpen(current.socket, options.signal);
      options.signal?.throwIfAborted();
      return current.link.call(path, input, options);
    },
  };
}
