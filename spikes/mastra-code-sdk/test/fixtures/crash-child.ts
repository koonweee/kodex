import assert from 'node:assert/strict';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { createProjectRuntime } from '../../src/runtime.js';

const [mode, profileRoot, projectPath, runtimeRoot] = process.argv.slice(2);
if (!mode || !profileRoot || !projectPath || !runtimeRoot) throw new Error('Missing disposable fixture arguments');
const profile = activateProfile(resolveProfile(profileRoot));
const runtime = await createProjectRuntime({
  projectPath,
  runtimeRoot,
  profile,
  disableMcp: true,
  modes: [{ id: 'build', defaultModelId: mode === 'inspect' ? 'fixture/judge' : 'fixture/chat', metadata: { default: true } }],
});
const session = await runtime.createSession({ resourceId: 'crash-resource', threadId: 'crash-thread' });
if (mode === 'inspect') {
  console.log(JSON.stringify({ type: 'inspected', messages: await session.thread.listActiveMessages(), model: session.model.get(), thinkingLevel: session.state.get().thinkingLevel, running: session.displayState.get().isRunning, queued: session.displayState.get().queuedFollowUps }));
  await runtime.dispose();
} else if (mode === 'queue') {
  await session.thread.rename({ title: 'Disposable crash fixture' });
  await session.state.set({ thinkingLevel: 'low' });
  await session.model.saveForMode({ modeId: 'build', modelId: 'fixture/chat' });
  await session.sendMessage({ content: 'COMPLETED_BEFORE_CRASH' });
  const completed = await session.thread.listActiveMessages();
  assert.ok(completed.some(message => message.role === 'assistant' && JSON.stringify(message).includes('fixture:COMPLETED_BEFORE_CRASH')), 'completed assistant output persisted before the crash');
  let streamed!: () => void;
  const firstDelta = new Promise<void>(resolve => { streamed = resolve; });
  session.subscribe(event => { if (event.type === 'message_update' && event.event.type === 'text-delta') streamed(); });
  void session.sendMessage({ content: 'IN_FLIGHT_CRASH' }).catch(error => console.error(String(error)));
  await firstDelta;
  await session.followUp({ content: 'QUEUED_LOST_ON_CRASH' });
  assert.equal(session.displayState.get().queuedFollowUps, 1);
  console.log(JSON.stringify({ type: 'queued', threadId: session.thread.getId() }));
  // The parent kills only this spawned fixture, while its model response remains held.
} else {
  throw new Error('Unknown disposable fixture mode');
}
