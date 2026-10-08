import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchAutomationState } from '../src/automation-watch.js';

test('independent automation observers refill native state and stop on disconnect', async () => {
  let rows = [{ id: 'one', status: 'active' }];
  const a = new AbortController(), b = new AbortController();
  const read = async () => structuredClone(rows);
  const first = watchAutomationState(read, a.signal, 1), second = watchAutomationState(read, b.signal, 1);
  const initial = await Promise.all([first.next(), second.next()]);
  assert.deepEqual(initial[0].value?.rows, rows);
  assert.notEqual(initial[0].value?.epoch, initial[1].value?.epoch);
  rows = [{ id: 'one', status: 'paused' }];
  const next = await Promise.all([first.next(), second.next()]);
  for (const row of next) { assert.deepEqual(row.value?.rows, rows); assert.equal(row.value?.revision, 2); }
  a.abort(); assert.equal((await first.next()).done, true);
  rows = []; assert.deepEqual((await second.next()).value?.rows, []);
  b.abort(); assert.equal((await second.next()).done, true);
});

test('a cancelled slow read cannot publish a late automation snapshot', async () => {
  const abort = new AbortController();
  let finish!: (value: string[]) => void;
  const read = new Promise<string[]>(resolve => { finish = resolve; });
  const watch = watchAutomationState(() => read, abort.signal, 1);
  const pending = watch.next(); abort.abort(); finish(['late']);
  assert.equal((await pending).done, true);
});
