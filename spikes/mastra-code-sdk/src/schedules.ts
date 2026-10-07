import type { ScheduleHooks, ScheduleEffective } from '@mastra/core/schedules';
import type { NativeSession } from './runtime.js';

export interface ScheduledConversation {
  agentId: string;
  resourceId: string;
  threadId: string;
}

/** Native schedule fires need CodeSDK's live Session context to resolve model,
 * workspace and tools. Persist only native schedule data; build this context
 * at fire time. Mastra still owns storage, calendar timing and delivery.
 */
export function scheduleSessionHooks(
  resolveSession: (target: ScheduledConversation) => Promise<NativeSession>,
): ScheduleHooks {
  return {
    async prepare({ agentId, schedule }) {
      const { resourceId, threadId } = schedule;
      if (typeof threadId !== 'string') return;
      if (typeof resourceId !== 'string') throw new Error('A scheduled conversation requires a resource identity');
      const session = await resolveSession({ agentId, resourceId, threadId });
      if (session.identity.getResourceId() !== resourceId || session.thread.getId() !== threadId) {
        throw new Error('The scheduled conversation does not match its Session');
      }
      const context = await session.machinery.buildRequestContext();
      const idle = schedule.ifIdle as ScheduleEffective['ifIdle'];
      return {
        ifIdle: {
          ...idle,
          streamOptions: {
            ...idle?.streamOptions,
            requestContext: { ...idle?.streamOptions?.requestContext, ...Object.fromEntries(context.entries()) },
          },
        },
      };
    },
  };
}
