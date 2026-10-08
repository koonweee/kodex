import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node-pty';

const unix = process.platform !== 'win32';

test('upstream PTY provides real terminal bytes, UTF-8 input, resize and normal exit', { skip: !unix, timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'kodex-native-pty-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const terminal = spawn('/bin/sh', ['-c', [
    '[ -t 0 ] && [ -t 1 ] && printf "TTY_READY\\n"',
    'stty -echo; stty size',
    'IFS= read -r line',
    'printf "UTF8_RESULT:%s\\n" "$line"',
    'printf "RESIZED:"; stty size',
    'printf "RAW_BYTE:\\377"',
    'exit 7',
  ].join('; ')], { cwd, env: { ...process.env, TERM: 'xterm-256color' }, name: 'xterm-256color', cols: 80, rows: 24, encoding: null });
  const chunks: Buffer[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  let finished = false;
  const exited = new Promise<{ exitCode: number; signal?: number }>(resolve => {
    terminal.onExit(event => { finished = true; resolve(event); });
  });
  const data = terminal.onData(chunk => {
    // encoding:null documents raw buffers; upstream's onData type remains string.
    assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk);
    if (Buffer.concat(chunks).includes(Buffer.from('24 80'))) resolveReady();
  });
  t.after(() => { data.dispose(); if (!finished) terminal.kill('SIGKILL'); });
  await ready;
  terminal.resize(101, 33);
  terminal.write(Buffer.from('café 🧪\n', 'utf8'));
  assert.deepEqual(await exited, { exitCode: 7, signal: 0 });
  const bytes = Buffer.concat(chunks);
  assert.ok(bytes.includes(Buffer.from('TTY_READY\r\n')));
  assert.ok(bytes.includes(Buffer.from('UTF8_RESULT:café 🧪\r\n', 'utf8')));
  assert.ok(bytes.includes(Buffer.from('RESIZED:33 101\r\n')));
  assert.ok(bytes.includes(Buffer.concat([Buffer.from('RAW_BYTE:'), Buffer.from([0xff])])), 'output retains non-UTF8 bytes without decoding loss');
});

test('upstream PTY kill terminates the owned child and reports its native signal', { skip: !unix, timeout: 10_000 }, async t => {
  const terminal = spawn('/bin/sh', ['-c', 'printf "KILL_READY\\n"; exec /bin/cat'], { cwd: tmpdir(), env: process.env, cols: 80, rows: 24, encoding: null });
  let finished = false;
  const exited = new Promise<{ exitCode: number; signal?: number }>(resolve => {
    terminal.onExit(event => { finished = true; resolve(event); });
  });
  const chunks: Buffer[] = [];
  const data = terminal.onData(chunk => {
    assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk);
    if (Buffer.concat(chunks).includes(Buffer.from('KILL_READY'))) terminal.kill('SIGKILL');
  });
  t.after(() => { data.dispose(); if (!finished) terminal.kill('SIGKILL'); });
  assert.equal((await exited).signal, 9);
});
