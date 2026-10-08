import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createTerminalService } from '../src/terminal-service.js';

test('shell state survives detach and resize; Stop removes it for every client', { timeout: 10_000 }, async t => {
  const service = createTerminalService({ defaultCwd: tmpdir() });
  t.after(() => service.dispose());
  const info = await service.create({ command: '/bin/sh' });
  assert.deepEqual(service.list().map(row => row.id), [info.id]);
  let output = ''; let receive: (() => void) | undefined;
  const data = (chunk: Buffer) => { output += chunk.toString(); receive?.(); };
  const observer = service.attach(info.id, { data, exit() {} });
  async function waitFor(text: string) {
    if (output.includes(text)) return;
    await new Promise<void>(resolve => { receive = () => { if (output.includes(text)) { receive = undefined; resolve(); } }; });
  }
  service.write(info.id, Buffer.from("stty -echo; export KODEX_TERMINAL_PROOF=preserved; printf 'READY\\n'\n"));
  await waitFor('READY\r\n');
  observer.detach(); observer.detach(); service.resize(info.id, 101, 33);
  let peerExit = 0;
  const peer = service.attach(info.id, { data, exit() { peerExit++; } });
  assert.ok(peer.history.includes(Buffer.from('READY')));
  service.write(info.id, Buffer.from("printf 'VALUE:%s\\n' \"$KODEX_TERMINAL_PROOF\"; stty size\n"));
  await waitFor('VALUE:preserved\r\n'); await waitFor('33 101');
  await service.delete(info.id);
  assert.equal(peerExit, 1); assert.deepEqual(service.list(), []);
  assert.throws(() => service.attach(info.id, { data, exit() {} }), /was not found/);
  peer.detach();
});

test('TTL starts at creation and last detach; attached peers prevent cleanup', { timeout: 10_000 }, async t => {
  let now = 0;
  const service = createTerminalService({ defaultCwd: tmpdir(), now: () => now });
  t.after(() => service.dispose());
  const first = await service.create({ command: '/bin/cat' });
  const a = service.attach(first.id, { data() {}, exit() {} });
  const b = service.attach(first.id, { data() {}, exit() {} });
  a.detach(); now = 300_001; assert.equal(service.list().length, 1);
  b.detach(); now += 299_999; assert.equal(service.list().length, 1);
  now += 1; assert.equal(service.list().length, 0);
  await service.create({ command: '/bin/cat' });
  now += 300_000; assert.equal(service.list().length, 0);
});

test('concurrent creation enforces eight shells and shutdown rejects creation', { timeout: 10_000 }, async t => {
  const service = createTerminalService({ defaultCwd: tmpdir() });
  t.after(() => service.dispose());
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => service.create({ command: '/bin/cat' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal(service.list().length, 8);
  await service.dispose();
  await assert.rejects(service.create({ command: '/bin/cat' }), /shutting down/);
});

test('reconnect history retains only the last MiB of raw output and normal process exit retires the shell', { timeout: 10_000 }, async t => {
  const service = createTerminalService({ defaultCwd: tmpdir() });
  t.after(() => service.dispose());
  const info = await service.create({ command: '/bin/sh' });
  let found!: () => void;
  const marker = new Promise<void>(resolve => { found = resolve; });
  let tail = '';
  const observer = service.attach(info.id, { data(bytes) {
    tail = (tail + bytes.toString()).slice(-100);
    if (tail.includes('BOUNDED_DONE\r\n')) found();
  }, exit() {} });
  service.write(info.id, Buffer.from("stty -echo; head -c 1200000 /dev/zero; printf 'BOUNDED_DONE\\n'\n"));
  await marker;
  const peer = service.attach(info.id, { data() {}, exit() {} });
  assert.equal(peer.history.length, 1024 * 1024);
  assert.ok(peer.history.includes(Buffer.from('BOUNDED_DONE')));
  assert.equal(service.list()[0]?.historySizeBytes, 1024 * 1024);
  observer.detach(); peer.detach();
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  service.attach(info.id, { data() {}, exit: finish });
  service.write(info.id, Buffer.from('exit\n')); await exited;
  assert.deepEqual(service.list(), []);
});

test('shutdown fences a terminal creation waiting on its project binding', async () => {
  let release!: (value: string) => void;
  const binding = new Promise<string>(resolve => { release = resolve; });
  const service = createTerminalService({ defaultCwd: tmpdir(), projectCwd: () => binding });
  const pending = service.create({ projectId: 'project', command: '/bin/cat' });
  await service.dispose(); release(tmpdir());
  await assert.rejects(pending, /shutting down/);
});

test('Stop hangs up shell jobs and forces a child that ignores hangup', { timeout: 10_000 }, async t => {
  const service = createTerminalService({ defaultCwd: tmpdir() });
  t.after(() => service.dispose());
  const info = await service.create({ command: '/bin/sh' });
  let job = 0; let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let output = '';
  service.attach(info.id, { data(bytes) {
    output += bytes.toString();
    const match = /OWNED_BACKGROUND:(\d+)/.exec(output);
    if (match) { job = Number(match[1]); ready(); }
  }, exit() {} });
  // Only the PID emitted by this owned shell is inspected or cleaned up.
  t.after(() => { if (job) { try { process.kill(job, 'SIGKILL'); } catch {} } });
  service.write(info.id, Buffer.from("set +H\nstty -echo; sleep 60 & printf 'OWNED_BACKGROUND:%s\\n' \"$!\"\n"));
  await started; t.diagnostic(`Owned job ${job} started`); await service.delete(info.id); t.diagnostic('First shell deleted');
  const { setTimeout: delay } = await import('node:timers/promises');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(job, 0); } catch { job = 0; break; }
    await delay(10);
  }
  assert.equal(job, 0, 'the interactive shell forwards hangup to its background job');
  const stubborn = await service.create({ command: '/bin/sh' });
  let installed!: () => void;
  const trapped = new Promise<void>(resolve => { installed = resolve; });
  let trapOutput = '';
  service.attach(stubborn.id, { data(bytes) {
    trapOutput += bytes.toString(); if (trapOutput.includes('TRAP_READY\r\n')) installed();
  }, exit() {} });
  service.write(stubborn.id, Buffer.from("stty -echo; trap '' HUP; printf 'TRAP_READY\\n'; exec /bin/cat\n"));
  await trapped; t.diagnostic('Hangup handler installed'); await service.delete(stubborn.id); t.diagnostic('Stubborn child deleted');
  assert.deepEqual(service.list(), []);
});
