import { applyChildSessionPolicy } from './child-policy.js';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { KODEX_CHILD_TAG, KODEX_CHILD_VERSION, readChildRelation, type ChildRelation } from './child-relation.js';
import type { NativeSession, ProjectRuntime } from './runtime.js';

function childTarget(taskId: string) {
  // Native task identity generates the child identity; the model names only taskId.
  const id = `kodex-child:${taskId}`;
  return { id, resourceId: id, threadId: id };
}
async function invokingParent(runtime: ProjectRuntime, context: ToolExecutionContext) {
  const origin = context.requestContext?.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
  if (!origin?.threadId || origin.controllerId !== runtime.controller.id) throw new Error('Child tools require a native parent session');
  const parent = await runtime.controller.getSessionByResource(origin.resourceId, origin.scope);
  if (!parent || parent.identity.getId() !== origin.session.id || parent.thread.getId() !== origin.threadId
    || (context.agent?.threadId !== undefined && context.agent.threadId !== origin.threadId)
    || (context.agent?.resourceId !== undefined && context.agent.resourceId !== origin.resourceId)) {
    throw new Error('Child tools require the original live parent session');
  }
  return { parent, origin };
}
async function canonicalResult(child: NativeSession, messageIds: ReadonlySet<string>) {
  const memory = await child.machinery.getAgent().getMemory({ requestContext: await child.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  const messages = await child.thread.listActiveMessages();
  const final = messages.findLast(message => messageIds.has(message.id) && message.role === 'assistant' && message.content.parts.some(part => part.type === 'text'));
  return final?.content.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

/** Mount as native extraTools. The getter resolves after runtime construction. */
export function createChildTools({ getRuntime }: { getRuntime: () => ProjectRuntime }) {
  const delegate = createTool({
    id: 'delegate_child',
    description: 'Run a fresh child in the background. Use the native acknowledgment Task ID with message_child for live guidance. Follow-up tasks create a new child.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', minLength: 1 } }, required: ['task'], additionalProperties: false },
    background: { enabled: true, defaultDisposition: 'deferred', maxRetries: 0 },
    execute: async (input, context) => {
      if (!context.background) throw new Error('delegate_child requires native background execution');
      const runtime = getRuntime(), taskId = context.background.taskId;
      let child: NativeSession | undefined, stoppedChild: NativeSession | undefined, cancelled = false, operationEnded = false;
      let finish!: () => void, fail!: (error: unknown) => void;
      const terminal = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      // Setup can fail or native cancellation can arrive before the operation
      // awaits its terminal event. Keep that early rejection owned here.
      void terminal.catch(() => {});
      const stop = () => {
        // Native task cancellation/result reads may settle after this operation
        // ended and independent input started on the retained Session.
        if (operationEnded) return;
        cancelled = true;
        // A parked native abort clears the question without promising a new
        // agent_end. Cancellation must also settle this logical operation.
        fail(new Error('Child task cancelled'));
        if (!child || child === stoppedChild) return;
        stoppedChild = child;
        const threadId = child.thread.getId();
        if (threadId) child.machinery.getAgent().abortThreadStream({ threadId, resourceId: child.identity.getResourceId(), clearPendingSignals: true });
        child.abort();
      };
      const completion = (async () => {
        const { parent, origin } = await invokingParent(runtime, context);
        if (origin.scope !== undefined) throw new Error('delegate_child currently requires an unscoped parent session');
        if (cancelled) throw new Error('Child task cancelled before launch');
        const relation: ChildRelation = { parentThreadId: origin.threadId!, parentResourceId: origin.resourceId,
          parentSessionScope: origin.scope ?? '', parentTaskId: taskId };
        const target = childTarget(taskId);
        // The model may override native maxRetries. A saved native row means
        // this task already launched its fresh child; retries must not resume it.
        if (await runtime.controller.queryThreadById({ threadId: target.threadId })) {
          throw new Error('A delegated child task cannot reopen an existing child thread');
        }
        const messageIds = new Set<string>();
        let resultMessageIds: ReadonlySet<string> = messageIds;
        let off = () => {};
        try {
          child = await runtime.createSession({ ...target,
            tags: { [KODEX_CHILD_TAG]: KODEX_CHILD_VERSION, ...relation } }, async (session, assertActive) => {
            child = session;
            if (cancelled) { stop(); throw new Error('Child task cancelled during launch'); }
            await applyChildSessionPolicy(child);
            await child.mode.switch({ modeId: parent.mode.get() });
            await child.model.switch(parent.model.get());
            await child.thread.rename({ title: (input as { task: string }).task.slice(0, 120), pin: true });
            if (cancelled) { stop(); throw new Error('Child task cancelled before execution'); }
            assertActive();
            off = child.subscribe(event => {
              if (event.type === 'message_start' && event.message.role === 'assistant') messageIds.add(event.message.id);
              if (event.type === 'error') { fail(event.error); off(); stop(); operationEnded = true; return; }
              if (event.type !== 'agent_end' || event.reason === 'suspended') return;
              // Freeze ownership synchronously before queued or direct work can
              // begin. Only IDs are captured; the result stays native history.
              operationEnded = true;
              resultMessageIds = new Set(messageIds);
              off();
              if (event.reason === 'complete') finish();
              else fail(new Error(`Child task ended without completion: ${event.reason}`));
            });
            // Exposure waits for native acceptance, not the response or a
            // parked question. The listener owns the logical task through resumes.
            const accepted = await child.sendSignal({ type: 'user', contents: (input as { task: string }).task },
              { untilIdle: false, requireDelivery: true }).accepted;
            if (accepted.action !== 'wake' && accepted.action !== 'deliver') throw new Error('Child input was not accepted');
          });
          await terminal;
          if (cancelled) throw new Error('Child task cancelled');
          return { taskId, childThreadId: child.thread.requireId(), result: await canonicalResult(child, resultMessageIds) };
        } finally { off(); }
      })().catch(error => {
        // Native adoption does not call cancel when an adopted completion
        // rejects after execute returns. Retract owned parked gates ourselves.
        stop();
        throw error;
      });
      // Like ordinary chats, the binding remains available for later native
      // input. Archive and runtime disposal own its eventual retirement.
      context.background.adopt({ completion, cancel: stop });
      return { taskId };
    },
  });
  const message = createTool({
    id: 'message_child',
    description: 'Send live guidance to your running delegate_child Task ID. A starting result means setup has not reached an active run; waiting_for_response means the child has a parked native prompt.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1 } },
      required: ['taskId', 'message'], additionalProperties: false },
    execute: async (input, context) => {
      const runtime = getRuntime(), { origin } = await invokingParent(runtime, context);
      const { taskId, message } = input as { taskId: string; message: string };
      const manager = runtime.mastra.backgroundTaskManager;
      const task = await manager?.getTask(taskId);
      if (!task || task.toolName !== 'delegate_child' || task.threadId !== origin.threadId || task.resourceId !== origin.resourceId) {
        throw new Error('Child task does not belong to this parent');
      }
      if (task.status !== 'pending' && task.status !== 'running') return { taskId, status: 'unavailable', taskStatus: task.status };
      const target = childTarget(taskId);
      // The native registry awaits in-progress creation; before registration the
      // supported result is starting, without a local readiness queue or polling.
      const child = await runtime.controller.getSessionByResource(target.resourceId);
      if (!child) return { taskId, status: 'starting' };
      const row = await runtime.controller.queryThreadById({ threadId: target.threadId });
      const relation = readChildRelation(row?.metadata);
      if (!relation || relation.parentTaskId !== taskId || relation.parentThreadId !== origin.threadId
        || relation.parentResourceId !== origin.resourceId || relation.parentSessionScope !== (origin.scope ?? '')
        || child.thread.getId() !== target.threadId || row?.resourceId !== target.resourceId) {
        throw new Error('Child task does not belong to this parent');
      }
      if (child.suspensions.hasPending()) return { taskId, status: 'waiting_for_response' };
      if (!child.machinery.getAgent().getActiveThreadRunId(target)) return { taskId, status: 'starting' };
      const delivery = await child.sendSignal({ type: 'reactive', contents: message },
        { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'discard' }, requireDelivery: true }).accepted;
      return { taskId, guidanceDelivered: delivery.action === 'deliver', action: delivery.action };
    },
  });
  return { delegate_child: delegate, message_child: message };
}
