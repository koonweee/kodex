import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatReadState } from '../src/chat-read-state.js';
import type { NativeSession, ProjectRuntime } from '../src/runtime.js';

type Listener = Parameters<NativeSession['subscribe']>[0];
function fixture() {
  const created = new Set<(session: NativeSession) => void>();
  const deleted = new Set<(session: NativeSession) => void>();
  const runtime = { controller: {
    onSessionCreated(listener: (session: NativeSession) => void) { created.add(listener); return () => { created.delete(listener); }; },
    onSessionDeleted(listener: (session: NativeSession) => void) { deleted.add(listener); return () => { deleted.delete(listener); }; },
  } } as unknown as ProjectRuntime;
  function session(threadId: string) {
    const listeners = new Set<Listener>();
    let runId: string | null = null, messageId: string | null = null, messageRole: 'assistant' | 'signal' = 'assistant', producerRunId: string | null = null;
    const native = { thread: { getId: () => threadId }, getCurrentRunId: () => producerRunId ?? runId, run: { getRunId: () => runId },
      displayState: { get: () => ({ currentMessage: messageId ? { id: messageId, role: messageRole } : null }) },
      subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } as unknown as NativeSession;
    for (const listener of created) listener(native);
    return {
      end(reason: 'complete' | 'aborted' | 'error' | 'suspended' | undefined, id: string | null = 'run', message: string | null = 'message', role: 'assistant' | 'signal' = 'assistant', nextProducerRunId: string | null = null) {
        runId = id; messageId = message; messageRole = role; producerRunId = nextProducerRunId;
        for (const listener of listeners) listener({ type: 'agent_end', reason });
        runId = null;
      },
      release() { for (const listener of deleted) listener(native); },
      get subscriptions() { return listeners.size; },
    };
  }
  return { runtime, session, get observers() { return created.size + deleted.size; } };
}

test('seen writes compare the binding, epoch, revision and exact current native run', () => {
  const f = fixture(), changed: Array<[string, string]> = [];
  const tracker = createChatReadState('epoch', (binding, thread) => changed.push([binding, thread]));
  tracker.observeRuntime(f.runtime, 'binding');
  const session = f.session('thread');
  assert.deepEqual(tracker.read('binding', 'thread'), { epoch: 'epoch', revision: 0, head: null, seen: null });
  session.end('complete', 'first', 'final');
  const first = tracker.read('binding', 'thread');
  assert.deepEqual(first.head, { runId: 'first', messageId: 'final', reason: 'complete' });
  assert.equal(first.seen, false);
  const ack = { bindingId: 'binding', threadId: 'thread', epoch: first.epoch, revision: first.revision, runId: 'first' };
  for (const input of [{ ...ack, epoch: 'old' }, { ...ack, revision: 0 }, { ...ack, runId: 'other' }, { ...ack, bindingId: 'other' }]) {
    assert.equal(tracker.acknowledge(input).outcome, 'conflict');
  }
  const accepted = tracker.acknowledge(ack);
  assert.equal(accepted.outcome, 'accepted'); assert.equal(accepted.state.seen, true);
  assert.ok(accepted.state.revision > first.revision);
  assert.equal(tracker.acknowledge(ack).outcome, 'conflict');
  const idempotent = tracker.acknowledge({ ...ack, revision: accepted.state.revision });
  assert.deepEqual(idempotent, accepted);
  session.end('aborted', 'second');
  assert.equal(tracker.acknowledge({ ...ack, revision: accepted.state.revision }).outcome, 'conflict');
  assert.equal(tracker.read('binding', 'thread').seen, false);
  assert.deepEqual(changed, [['binding', 'thread'], ['binding', 'thread'], ['binding', 'thread']]);
});

test('all native scopes share a head within a binding and separate bindings never collide', () => {
  const one = fixture(), two = fixture();
  const tracker = createChatReadState('epoch', () => {});
  tracker.observeRuntime(one.runtime, 'one'); tracker.observeRuntime(two.runtime, 'two');
  const ordinary = one.session('thread'), scoped = one.session('thread'), independent = two.session('thread');
  ordinary.end('complete', 'z-run'); scoped.end('error', 'a-run', null);
  assert.deepEqual(tracker.read('one', 'thread').head, { runId: 'a-run', messageId: null, reason: 'error' });
  assert.equal(tracker.read('two', 'thread').head, null);
  independent.end('complete', 'other');
  assert.equal(tracker.read('one', 'thread').head?.runId, 'a-run');
  assert.equal(tracker.read('two', 'thread').head?.runId, 'other');
  scoped.release(); ordinary.release();
  assert.equal(tracker.read('one', 'thread').head?.runId, 'a-run', 'Session release preserves this service epoch head');
  scoped.end('complete', 'released');
  assert.equal(tracker.read('one', 'thread').head?.runId, 'a-run');
});

test('suspension preserves prior state and missing native identity invalidates to newer unknown state', () => {
  const f = fixture(), tracker = createChatReadState('epoch', () => {});
  tracker.observeRuntime(f.runtime, 'binding'); const session = f.session('thread');
  session.end('suspended');
  assert.equal(tracker.read('binding', 'thread').revision, 0);
  session.end('complete'); const first = tracker.read('binding', 'thread');
  session.end('suspended', 'parked'); assert.deepEqual(tracker.read('binding', 'thread'), first);
  session.end('error', null); const unknown = tracker.read('binding', 'thread');
  assert.deepEqual({ head: unknown.head, seen: unknown.seen }, { head: null, seen: null });
  assert.ok(unknown.revision > first.revision);
  assert.equal(tracker.acknowledge({ bindingId: 'binding', threadId: 'thread', epoch: 'epoch', revision: unknown.revision, runId: 'run' }).outcome, 'conflict');
  session.end(undefined); assert.equal(tracker.read('binding', 'thread').head, null);
});

test('forget invalidates only named binding threads and returned state cannot mutate the tracker', () => {
  const f = fixture(), tracker = createChatReadState('epoch', () => {});
  tracker.observeRuntime(f.runtime, 'binding'); f.session('thread').end('complete'); f.session('retained').end('complete');
  const state = tracker.read('binding', 'thread'); assert.ok(state.head); state.head.runId = 'tampered'; state.seen = true;
  assert.equal(tracker.read('binding', 'thread').head?.runId, 'run'); assert.equal(tracker.read('binding', 'thread').seen, false);
  tracker.forget('binding', ['thread']);
  const forgotten = tracker.read('binding', 'thread');
  assert.equal(forgotten.head, null); assert.equal(forgotten.seen, null); assert.ok(forgotten.revision > state.revision);
  assert.equal(tracker.read('binding', 'retained').head?.runId, 'run');
  assert.equal(createChatReadState('next-epoch', () => {}).read('binding', 'thread').head, null);
});

test('observation is idempotent and disposal closes subscriptions and seen admissions immediately', () => {
  const f = fixture(), changed: string[] = [], tracker = createChatReadState('epoch', (_binding, thread) => changed.push(thread));
  tracker.observeRuntime(f.runtime, 'binding'); tracker.observeRuntime(f.runtime, 'binding');
  assert.equal(f.observers, 2); const session = f.session('thread'); assert.equal(session.subscriptions, 1);
  session.end('complete'); const state = tracker.read('binding', 'thread');
  tracker.dispose(); tracker.dispose(); assert.equal(f.observers, 0); assert.equal(session.subscriptions, 0);
  session.end('error', 'ignored'); tracker.observeRuntime(f.runtime, 'binding'); f.session('new').end('complete');
  assert.deepEqual(changed, ['thread']);
  assert.equal(tracker.acknowledge({ bindingId: 'binding', threadId: 'thread', epoch: 'epoch', revision: state.revision, runId: 'run' }).outcome, 'conflict');
});

test('a native input signal is never exposed as a terminal assistant witness', () => {
  const f = fixture(), tracker = createChatReadState('epoch', () => {});
  tracker.observeRuntime(f.runtime, 'binding'); const session = f.session('thread');
  session.end('complete', 'answered', 'answer');
  session.end('error', 'failed', 'submitted-user', 'signal');
  const state = tracker.read('binding', 'thread');
  assert.deepEqual(state.head, { runId: 'failed', messageId: null, reason: 'error' });
  assert.equal(state.seen, false);
});

test('terminal identity belongs to the consumed run even when the native producer has started later work', () => {
  const f = fixture(), tracker = createChatReadState('epoch', () => {});
  tracker.observeRuntime(f.runtime, 'binding');
  f.session('thread').end('complete', 'consumed', 'finished-answer', 'assistant', 'next-running');
  assert.deepEqual(tracker.read('binding', 'thread').head, { runId: 'consumed', messageId: 'finished-answer', reason: 'complete' });
});

test('notification capture names native terminal events only, independently of seen and invalidation writes', () => {
  const f = fixture(), terminals: unknown[] = [];
  const tracker = createChatReadState('epoch', () => {}, event => terminals.push(event));
  tracker.observeRuntime(f.runtime, 'binding'); const session = f.session('thread');
  session.end('suspended'); session.end('error', null);
  assert.deepEqual(terminals, []);
  session.end('complete', 'native-run', 'answer');
  assert.deepEqual(terminals, [{ bindingId: 'binding', threadId: 'thread', runId: 'native-run', reason: 'complete' }]);
  const state = tracker.read('binding', 'thread');
  tracker.acknowledge({ bindingId: 'binding', threadId: 'thread', epoch: state.epoch, revision: state.revision, runId: 'native-run' });
  tracker.forget('binding', ['thread']);
  assert.equal(terminals.length, 1);
  session.end('error', 'failed-before-answer', 'input', 'signal');
  assert.deepEqual(terminals[1], { bindingId: 'binding', threadId: 'thread', runId: 'failed-before-answer', reason: 'error' });
  tracker.dispose(); session.end('complete', 'after-disposal'); assert.equal(terminals.length, 2);
});
