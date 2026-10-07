import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('closes the browser RPC stream when the upstream response is abruptly aborted', async () => {
  // Vite/esbuild require the Node realm, while this repository's UI tests use jsdom.
  const result = promisify(execFile)(process.execPath, ['--import', '../../spikes/mastra-code-sdk/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', String.raw`
    import { createServer as createHttpServer } from 'node:http';
    import { once } from 'node:events';
    import { strict as assert } from 'node:assert';
    import { createServer as createViteServer } from 'vite';
    import { forwardRpcAbort } from './vite-rpc-proxy.ts';
    let upstreamResponse;
    const upstream = createHttpServer((_request, response) => { upstreamResponse = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('initial\n'); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const vite = await createViteServer({ configFile: false, server: { middlewareMode: true, proxy: { '/rpc': { target: 'http://127.0.0.1:' + upstream.address().port, configure: forwardRpcAbort } } }, appType: 'custom', logLevel: 'silent' });
    const proxy = createHttpServer(vite.middlewares);
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    let timer;
    try {
      const response = await fetch('http://127.0.0.1:' + proxy.address().port + '/rpc/watchChat');
      const reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'initial\n');
      upstreamResponse.destroy();
      const next = await Promise.race([reader.read().then(() => 'ended', () => 'aborted'), new Promise(resolve => { timer = setTimeout(() => resolve('still open'), 500); })]);
      assert.equal(next, 'aborted');
    } finally {
      clearTimeout(timer); upstream.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve)), vite.close()]);
    }
  `], { cwd: process.cwd(), timeout: 10_000 });
  await expect(result).resolves.toMatchObject({ stderr: '' });
});
