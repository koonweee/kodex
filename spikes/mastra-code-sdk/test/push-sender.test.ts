import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, Agent } from 'node:https';
import { createRequire } from 'node:module';
import webPush from 'web-push';
import { createPushSender, readPushConfig, type PushPayload } from '../src/push-sender.js';

const config = { ...webPush.generateVAPIDKeys(), subject: 'mailto:test@example.com', recheckDelayMs: 2_000 };
test('configuration is explicitly loaded and validates native Web Push options', () => {
  assert.equal(readPushConfig({}), null);
  assert.equal(readPushConfig({ KODEX_VAPID_PUBLIC_KEY: config.publicKey }), null);
  const env = { KODEX_VAPID_PUBLIC_KEY: config.publicKey, KODEX_VAPID_PRIVATE_KEY: config.privateKey, KODEX_VAPID_SUBJECT: config.subject };
  assert.deepEqual(readPushConfig(env), config);
  assert.equal(readPushConfig({ ...env, KODEX_NOTIFICATIONS_RECHECK_DELAY_MS: '0' })?.recheckDelayMs, 0);
  assert.throws(() => readPushConfig({ ...env, KODEX_NOTIFICATIONS_RECHECK_DELAY_MS: '-1' }), /recheck delay/);
  assert.throws(() => readPushConfig({ ...env, KODEX_VAPID_PRIVATE_KEY: 'invalid' }));
});

test('maintained sender makes a locally encrypted HTTPS request and classifies provider responses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-tls-'));
  const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  const ece = createRequire(import.meta.url)('http_ece') as { decrypt(body: Buffer, params: { version: string; privateKey: typeof receiver; authSecret: string }): Buffer };
  const payload: PushPayload = { kind: 'unreadAgentMessage', title: 'Native chat', body: 'Agent has a new message.', threadId: 'chat', route: '/threads/chat' };
  let status = 201, requests = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-encoding'], 'aes128gcm');
    assert.match(String(request.headers.authorization), /^vapid t=.+, k=.+/);
    assert.equal(Number(request.headers.ttl), 2_419_200); // Maintained library default retains offline delivery.
    assert.equal(body.includes(Buffer.from(payload.body)), false);
    assert.deepEqual(JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: receiver, authSecret: auth }).toString()), payload);
    requests++; response.writeHead(status); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const agent = new Agent({ rejectUnauthorized: false }); // Disposable fixture only; production uses platform TLS trust.
  t.after(async () => { agent.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const subscription = { endpoint: `https://127.0.0.1:${address.port}/push`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth } };
  const sender = createPushSender(config, { agent });
  assert.equal(await sender(subscription, payload), 'sent');
  for (const code of [404, 410]) { status = code; assert.equal(await sender(subscription, payload), 'stale'); }
  status = 503; assert.equal(await sender(subscription, payload), 'temporary');
  assert.equal(requests, 4);
});
