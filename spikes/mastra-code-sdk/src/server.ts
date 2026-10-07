import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AnyRouter } from '@orpc/server';
import { BodyLimitPlugin, RPCHandler } from '@orpc/server/node';

/** Dedicated localhost backend. Unported routes fail here; no upstream fallback. */
export async function serveRouter(router: AnyRouter, port = 8789) {
  const handler = new RPCHandler(router, { plugins: [new BodyLimitPlugin({ maxBodySize: 1_048_576 })] });
  const server = createServer((request, response) => {
    void handler.handle(request, response, { prefix: '/rpc', context: {} }).then(({ matched }) => {
      if (!matched) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Route not found on the Mastra backend.' } }));
      }
    }).catch(() => {
      // Native errors can contain provider credentials; never log their raw bodies.
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No Mastra server address');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
