import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { os, type RouterClient } from '@orpc/server';
import { serveRouter } from '../src/server.js';

const index = '<!doctype html><title>Native built frontend</title>';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kodex-frontend-http-'));
  const frontendDir = join(root, 'dist');
  await Promise.all(['assets', 'rpc', 'v1', 'terminals'].map(directory => mkdir(join(frontendDir, directory), { recursive: true })));
  await Promise.all([
    writeFile(join(frontendDir, 'index.html'), index),
    writeFile(join(frontendDir, 'assets', 'index-Abc12345.js'), 'export const built = true;'),
    writeFile(join(frontendDir, 'assets', 'styles-Xyz12345.css'), 'body { margin: 0; }'),
    writeFile(join(frontendDir, 'assets', 'unhashed.js'), 'export const unversioned = true;'),
    writeFile(join(frontendDir, 'sw.js'), "self.addEventListener('fetch', () => {});"),
    writeFile(join(frontendDir, 'manifest.webmanifest'), '{"name":"Native Kodex","start_url":"/"}'),
    writeFile(join(frontendDir, '.env'), 'hidden fixture secret'),
    writeFile(join(root, 'outside-secret.txt'), 'outside fixture secret'),
    ...['rpc', 'v1', 'terminals'].map(directory => writeFile(join(frontendDir, directory, 'fake.html'), 'API namespace must not expose this file')),
  ]);
  return { root, frontendDir };
}
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'GET' }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body })); response.on('error', reject);
    });
    request.on('error', reject); request.end();
  });
}

test('optional built frontend serves assets, manifest, worker and SPA links with update-safe cache headers', async t => {
  const files = await fixture(); t.after(() => rm(files.root, { recursive: true, force: true }));
  const server = await serveRouter({}, 0, undefined, undefined, { frontendDir: files.frontendDir }); t.after(() => server.close());
  for (const path of ['/', '/index.html', '/projects/project-a/chat/thread-b?view=split']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200, path); assert.equal(await response.text(), index);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  for (const [path, contentType, cache, body] of [
    ['/assets/index-Abc12345.js', /javascript/, 'public, max-age=31536000, immutable', 'export const built = true;'],
    ['/assets/styles-Xyz12345.css', /^text\/css/, 'public, max-age=31536000, immutable', 'body { margin: 0; }'],
    ['/assets/unhashed.js', /javascript/, 'no-cache', 'export const unversioned = true;'],
    ['/sw.js', /javascript/, 'no-cache', "self.addEventListener('fetch', () => {});"],
    ['/manifest.webmanifest', /application\/manifest\+json/, 'no-cache', '{"name":"Native Kodex","start_url":"/"}'],
  ] as const) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200, path); assert.equal(await response.text(), body);
    assert.match(response.headers.get('content-type') ?? '', contentType); assert.equal(response.headers.get('cache-control'), cache);
    const head = await fetch(server.url + path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
  }
  const worker = await fetch(server.url + '/sw.js');
  assert.ok(worker.headers.get('etag'));
  const unchanged = await fetch(server.url + '/sw.js', { headers: { 'if-none-match': worker.headers.get('etag')! } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
});

test('frontend cannot consume API errors, unknown assets, unsafe paths or non-read requests', async t => {
  const files = await fixture(); t.after(() => rm(files.root, { recursive: true, force: true }));
  const router = { info: os.handler(() => ({ native: true })) };
  const server = await serveRouter(router, 0, undefined, undefined, { frontendDir: files.frontendDir }); t.after(() => server.close());
  const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ url: server.url + '/rpc' }));
  assert.deepEqual(await client.info(), { native: true });
  const wrongMethod = await fetch(server.url + '/rpc/info'); assert.equal(wrongMethod.status, 405); assert.doesNotMatch(await wrongMethod.text(), /Native built frontend/);
  for (const path of ['/rpc', '/rpc/missing', '/rpc/fake.html', '/v1', '/v1/missing', '/v1/fake.html', '/terminals', '/terminals/fake.html', '/assets/missing.js', '/sw-missing.js']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 404, path); assert.doesNotMatch(await response.text(), /Native built frontend|API namespace/);
  }
  for (const path of ['/r%70c/fake.html', '/%76%31/fake.html', '/.env', '/%2eenv', '/../outside-secret.txt', '/%2e%2e%2foutside-secret.txt']) {
    const response = await rawGet(server.url, path);
    assert.equal(response.status, 404, path); assert.doesNotMatch(response.body, /secret|API namespace/);
  }
  for (const path of ['/', '/sw.js', '/projects/a/chat/b']) {
    const response = await fetch(server.url + path, { method: 'POST', body: 'cannot write frontend' });
    assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /Native built frontend/);
  }
});

test('configured frontend roots must contain a readable built index before server binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-frontend-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'not-a-directory'), 'fixture'); await mkdir(join(root, 'index.html'));
  for (const frontendDir of ['', join(root, 'missing'), join(root, 'not-a-directory'), root]) {
    await assert.rejects(async () => {
      // Also close a mistakenly admitted server, so the initial red test cannot leak it.
      const server = await serveRouter({}, 0, undefined, undefined, { frontendDir }); await server.close();
    }, /frontend/i);
  }
});


test('live frontend replacement refreshes worker validators, HTML bytes and newly built assets', async t => {
  const files = await fixture(); t.after(() => rm(files.root, { recursive: true, force: true }));
  const server = await serveRouter({}, 0, undefined, undefined, { frontendDir: files.frontendDir }); t.after(() => server.close());
  const previous = await fetch(server.url + '/sw.js'); await previous.text();
  const previousEtag = previous.headers.get('etag'); assert.ok(previousEtag);
  const nextWorker = "self.addEventListener('fetch', () => {}); /* changed built worker */";
  const nextIndex = '<!doctype html><title>Updated native frontend</title><script src="/assets/new-Next1234.js"></script>';
  const nextAsset = 'export const updated = true;';
  for (const [path, body] of [['sw.js', nextWorker], ['index.html', nextIndex], ['assets/new-Next1234.js', nextAsset]] as const) {
    const temporary = join(files.frontendDir, `${path}.next`);
    await writeFile(temporary, body); await rename(temporary, join(files.frontendDir, path));
  }
  const updated = await fetch(server.url + '/sw.js', { headers: { 'if-none-match': previousEtag } });
  assert.equal(updated.status, 200, 'a replaced native worker cannot reuse the previous validator');
  assert.notEqual(updated.headers.get('etag'), previousEtag);
  assert.equal(updated.headers.get('cache-control'), 'no-cache');
  assert.equal(updated.headers.get('content-length'), String(Buffer.byteLength(nextWorker)));
  assert.equal(await updated.text(), nextWorker);
  for (const path of ['/', '/chat/new-native-thread']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200); assert.equal(await response.text(), nextIndex);
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(nextIndex)));
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  const asset = await fetch(server.url + '/assets/new-Next1234.js');
  assert.equal(asset.status, 200); assert.equal(await asset.text(), nextAsset);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});
