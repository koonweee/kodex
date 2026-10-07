import type { ProxyOptions } from 'vite';

/** Node's pipe does not close its destination when the upstream stream aborts.
 * Forward that failure so the browser's oRPC iterator can reconnect normally.
 */
export const forwardRpcAbort: NonNullable<ProxyOptions['configure']> = proxy => {
  proxy.on('proxyRes', (upstream, _request, browserResponse) => {
    upstream.once('aborted', () => browserResponse.destroy());
  });
};
