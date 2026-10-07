import { activateProfile, resolveProfile } from '../../src/profile.js';
import { openProductRegistry } from '../../src/product-registry.js';
import { createProjectRuntime } from '../../src/runtime.js';
import { createChatService, type ChatSnapshot } from '../../src/chat-service.js';

const [mode, profileRoot, projectPath, runtimeRoot] = process.argv.slice(2);
if (!['queue', 'inspect'].includes(mode!) || !profileRoot || !projectPath || !runtimeRoot) throw new Error('Invalid queue restart fixture arguments');
const profile = activateProfile(resolveProfile(profileRoot));
let runtime!: Awaited<ReturnType<typeof createProjectRuntime>>;
const service = createChatService({ profile, instanceId: 'queue-restart-fixture', registryFactory: () => openProductRegistry(resolveProfile(`${runtimeRoot}-product-profile`)), projects: [{ id: 'project', name: 'Crash fixture', path: projectPath, runtimeRoot }],
  runtimeFactory: async options => { runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); return runtime; },
});
async function publish(report: object) { await new Promise<void>((resolve, reject) => process.send!(report, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve())); }
async function until(watch: AsyncIterator<ChatSnapshot>, predicate: (snapshot: ChatSnapshot) => boolean) {
  for (;;) { const next = await watch.next(); if (next.done) throw new Error('Fixture watch closed'); if (predicate(next.value)) return next.value; }
}
if (mode === 'queue') {
  const chat = await service.createChat({ projectId: 'project' });
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id });
  const session = (await runtime.controller.getSessionByResource(thread!.resourceId))!;
  await session.thread.rename({ title: 'Queue restart fixture' });
  const watch = service.watchChat({ chatId: chat.id }); await watch.next();
  await service.send({ chatId: chat.id, text: 'QUEUE_CRASH_COMPLETED' });
  await until(watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('fixture:QUEUE_CRASH_COMPLETED'));
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  await service.send({ chatId: chat.id, text: 'QUEUE_CRASH_ACTIVE' });
  const queued = await service.queue({ chatId: chat.id, text: 'QUEUE_CRASH_WAITING' });
  await publish({ type: 'queued', chatId: chat.id, queue: queued.snapshot });
  await new Promise(() => {}); // Parent kills only this disposable, authorized child.
} else {
  const chat = (await service.listChats()).chats[0];
  if (!chat) throw new Error('Persisted fixture chat missing');
  const snapshot = await service.openChat({ chatId: chat.id });
  await publish({ type: 'inspected', snapshot });
  await service.dispose();
  process.disconnect?.();
}
