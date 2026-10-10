import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session, type MastraDBMessage } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { createSessionProjection } from '../src/transport.js';

const message = (id: string, text: string): MastraDBMessage => ({
  id, role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text }] },
});

for (const reason of ['complete', 'aborted', 'error'] as const) {
  test(`${reason} hands live output to fresh history atomically for every client`, async (t) => {
    const session = new Session<MastraCodeState>({ id: 'session', resourceId: 'resource', ownerId: 'owner' });
    const projection = createSessionProjection(session);
    t.after(() => projection.dispose());
    let saved: MastraDBMessage[] = [];
    t.mock.method(session.thread, 'listActiveMessages', async () => saved);
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: message('live-a', 'Answer') });
    const running = await projection.snapshot();
    assert.equal(running.display.currentMessage?.id, 'live-a');
    session.emit({ type: 'agent_end', reason });

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(session.thread, 'listActiveMessages', async () => { await gate; return saved; });
    const finishing = projection.snapshot();
    // No terminal snapshot is published while the canonical read is outstanding.
    assert.equal(running.display.currentMessage?.id, 'live-a');
    saved = [message('saved-b', 'Answer'), message('saved-c', 'Answer')];
    release();
    const settled = await finishing;
    assert.equal(settled.display.currentMessage, null);
    assert.deepEqual(settled.messages, saved, 'legitimate repeated answers retain distinct identities');
    assert.equal(session.displayState.get().currentMessage?.id, 'live-a', 'projection never mutates native state');
    assert.deepEqual((await projection.snapshot()).messages, saved, 'second client uses the same history');
    assert.equal((await projection.snapshot()).display.currentMessage, null);
    const reconnected = createSessionProjection(session);
    t.after(() => reconnected.dispose());
    assert.equal((await reconnected.snapshot()).display.currentMessage, null, 'reconnect cannot revive retained native text');
    t.mock.method(session.thread, 'listActiveMessages', async () => { throw new Error('history unavailable'); });
    await assert.rejects(projection.snapshot(), /history unavailable/);
  });
}

test('suspended tool output remains live until its run resumes and settles', async (t) => {
  const session = new Session<MastraCodeState>({ id: 'session', resourceId: 'resource', ownerId: 'owner' });
  const projection = createSessionProjection(session);
  t.after(() => projection.dispose());
  session.emit({ type: 'agent_start' });
  session.emit({ type: 'message_start', message: message('live-a', 'Question') });
  session.emit({ type: 'tool_suspended', toolCallId: 'ask', toolName: 'ask_user', args: {}, suspendPayload: {} });
  session.emit({ type: 'agent_end', reason: 'suspended' });
  assert.equal((await projection.snapshot()).display.currentMessage?.id, 'live-a');
  session.emit({ type: 'agent_end', reason: 'complete' });
  assert.equal((await projection.snapshot()).display.currentMessage, null);
});
