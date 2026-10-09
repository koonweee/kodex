import { createFrontendUpdates } from './frontend-updates.js';
import { frontendUpdateRouter } from './frontend-updates-router.js';
import { connectTerminalSocket, type TerminalSocketManager } from './terminal-websocket.js';
import { handleFilePreview } from './file-preview-http.js';
import { createFrontendHttp } from './frontend-http.js';
import type { ChatService } from './chat-service.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AnyRouter } from '@orpc/server';
import { BodyLimitPlugin, RPCHandler } from '@orpc/server/node';
import { RPCHandler as WebsocketHandler } from '@orpc/server/websocket';
import { WebSocketServer } from 'ws';

/** Dedicated localhost backend. Unported routes fail here; no upstream fallback. */
export async function serveRouter(router: AnyRouter, port = 8789, files?: Pick<ChatService, 'previewFile'>, terminals?: TerminalSocketManager, options: { frontendDir?: string } = {}) {
  const frontend = options.frontendDir === undefined ? undefined : await createFrontendHttp(options.frontendDir);
  const frontendUpdates = createFrontendUpdates();
  const context = { frontendUpdates };
  const hostRouter = { ...router, ...frontendUpdateRouter };
  const websocketHandler = new WebsocketHandler(hostRouter);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const messages = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const handler = new RPCHandler(hostRouter, { plugins: [new BodyLimitPlugin({ maxBodySize: 1_048_576 })] });
  // Native oRPC multipart encoding handles one uploaded File per request. Keep
  // large bodies off the shared socket and leave ordinary command limits intact.
  const uploadHandler = new RPCHandler(hostRouter, { plugins: [new BodyLimitPlugin({ maxBodySize: 26 * 1024 * 1024 })] });
  const server = createServer((request, response) => {
    const selectedHandler = ['/rpc/uploadFile', '/rpc/uploadImage'].includes(request.url?.split('?')[0] ?? '') ? uploadHandler : handler;
    const pending = (async () => {
      if (files && await handleFilePreview(request, response, files)) return;
      const { matched } = await selectedHandler.handle(request, response, { prefix: '/rpc', context });
      if (!matched && !(frontend && await frontend(request, response))) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Route not found on the Mastra backend.' } }));
      }
    })().catch(() => {
      // Native errors can contain provider credentials; never log their raw bodies.
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    messages.add(pending);
    void pending.finally(() => messages.delete(pending));
  });
  server.on('upgrade', (request, socket, head) => {
    let allowedOrigin = !request.headers.origin;
    try {
      if (request.headers.origin && request.headers.host) {
        const origin = new URL(request.headers.origin);
        allowedOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === new URL(`${origin.protocol}//${request.headers.host}`).host;
      }
    } catch { allowedOrigin = false; }
    const path = request.url?.split('?')[0];
    const terminalId = terminals ? /^\/v1\/terminals\/([^/]+)\/ws$/.exec(path ?? '')?.[1] : undefined;
    if (closing || (path !== '/rpc' && !terminalId) || !allowedOrigin) {
      const status = closing ? '503 Service Unavailable' : allowedOrigin ? '404 Not Found' : '403 Forbidden';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (terminalId && terminals) {
      terminalSockets.handleUpgrade(request, socket, head, connection => connectTerminalSocket(connection, terminalId, terminals));
    } else sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  });
  sockets.on('connection', socket => {
    socket.binaryType = 'arraybuffer';
    socket.on('message', (data, binary) => {
      // Use the public native message/close API so malformed transport errors
      // are contained here instead of the convenience adapter's raw logger.
      const pending = websocketHandler.message(socket, binary ? data as ArrayBuffer : data.toString(), { context }).catch(() => {
        if (socket.readyState === socket.OPEN) socket.close(1002, 'Invalid RPC message');
      });
      messages.add(pending);
      void pending.finally(() => messages.delete(pending));
    });
    socket.on('close', () => websocketHandler.close(socket));
    socket.on('error', () => {
      websocketHandler.close(socket);
      // ws already starts its protocol close for oversized/invalid frames.
      // Preserve that close code; terminate only a still-open failed transport.
      if (socket.readyState === socket.OPEN) socket.terminate();
    });
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No Mastra server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      return closing ??= (async () => {
        frontendUpdates.dispose();
        for (const socket of sockets.clients) { websocketHandler.close(socket); socket.terminate(); }
        for (const socket of terminalSockets.clients) socket.terminate();
        await Promise.all([
          new Promise<void>((resolve, reject) => terminalSockets.close(error => error ? reject(error) : resolve())),
          new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve())),
          new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
          }),
        ]);
        // Native close aborts every request/iterator. Join their finally blocks
        // before the caller retires project runtimes and storage.
        await Promise.allSettled(messages);
      })();
    },
  };
}
