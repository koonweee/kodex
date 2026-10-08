import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import type { PublicSchema } from '@mastra/core/schema';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { ORPCError } from '@orpc/server';
import { isChildThread } from './child-relation.js';
import type { ChatService } from './chat-service.js';
import type { HistoryRequest } from './chat-history.js';
import type { ProjectRuntime } from './runtime.js';

interface ControlOptions { getRuntime(): ProjectRuntime; getService(): ChatService }
const denied = () => new Error('Kodex Control requires an original live ordinary chat session.');
const id = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' } as const;
const nullableId = { anyOf: [id, { type: 'null' as const }] };
const history = { type: 'object', properties: {
  earliest: { type: 'string', minLength: 1, maxLength: 256 }, older: { type: 'boolean' },
}, additionalProperties: false } as const;
type JsonSchema = Extract<PublicSchema, { type?: unknown }>;
const schema = (properties: NonNullable<JsonSchema['properties']> = {}, required: string[] = []): PublicSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

async function authorize(runtime: ProjectRuntime, context: ToolExecutionContext) {
  const origin = context.requestContext?.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
  if (!origin?.threadId || !origin.resourceId || !origin.session?.id || origin.controllerId !== runtime.controller.id
    || origin.scope !== undefined || origin.abortSignal?.aborted || context.abortSignal?.aborted
    || (context.agent?.threadId !== undefined && context.agent.threadId !== origin.threadId)
    || (context.agent?.resourceId !== undefined && context.agent.resourceId !== origin.resourceId)) throw denied();
  const thread = await runtime.controller.queryThreadById({ threadId: origin.threadId });
  if (!thread || thread.resourceId !== origin.resourceId || thread.metadata?.projectPath !== runtime.projectPath
    || thread.metadata?.forkedSubagent === true || isChildThread(thread.metadata)) throw denied();
  // Reads may overlap retirement. Recheck the current native binding after the
  // metadata read; a captured request context alone cannot authorize a tool.
  const session = await runtime.controller.getSessionByResource(origin.resourceId, origin.scope);
  if (!session || session.identity.getId() !== origin.session.id || session.thread.getId() !== origin.threadId
    || session.identity.getResourceId() !== origin.resourceId || origin.abortSignal?.aborted
    || origin.isThreadActive?.() === false || context.abortSignal?.aborted) throw denied();
}

/** Native host tools only: no MCP/plugin facade, transport or duplicate runtime. */
export function createControlTools(options: ControlOptions) {
  function tool<I extends object>(name: string, description: string, inputSchema: PublicSchema,
    run: (input: I, service: ChatService) => Promise<unknown>) {
    return createTool({ id: name, description, inputSchema, background: { enabled: false },
      execute: async (input, context) => {
        await authorize(options.getRuntime(), context);
        return run(input as I, options.getService());
      },
    });
  }
  const missing = () => new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });
  return {
    get_status: tool('get_status', 'Read the connected native Kodex host identity.', schema(),
      (_input, service) => service.info()),
    list_projects: tool('list_projects', 'List projects from the current native Kodex catalog.', schema(),
      async (_input, service) => ({ projects: (await service.listChats()).projects })),
    get_project: tool<{ projectId: string }>('get_project', 'Read an existing Kodex project.', schema({ projectId: id }, ['projectId']),
      async ({ projectId }, service) => {
        const project = (await service.listChats()).projects.find(row => row.id === projectId);
        if (!project) throw missing(); return project;
      }),
    list_threads: tool<{ projectId?: string | null }>('list_threads', 'List ordinary nonarchived Kodex chats. Omit projectId for all; null selects standalone chats.',
      schema({ projectId: nullableId }), async (input, service) => {
        const catalog = await service.listChats();
        return { chats: input.projectId === undefined ? catalog.chats : catalog.chats.filter(chat => chat.projectId === input.projectId) };
      }),
    list_sidebar_threads: tool('list_sidebar_threads', 'Read the canonical Kodex sidebar catalog and pinned order.', schema(),
      (_input, service) => service.listChats()),
    list_pinned_threads: tool('list_pinned_threads', 'List pinned ordinary Kodex chats in their shared order.', schema(),
      async (_input, service) => {
        const catalog = await service.listChats(), chats = new Map(catalog.chats.map(chat => [chat.id, chat]));
        return { chats: catalog.pinnedChatIds.map(chatId => chats.get(chatId)).filter(chat => chat !== undefined) };
      }),
    get_thread: tool<{ threadId: string }>('get_thread', 'Read ordinary Kodex chat metadata without loading its session.',
      schema({ threadId: id }, ['threadId']), ({ threadId }, service) => service.readControlChat({ chatId: threadId })),
    get_thread_timeline: tool<{ threadId: string; history?: HistoryRequest }>('get_thread_timeline',
      'Read retained native Kodex chat history without loading its session. Use the returned history boundary for older reads.',
      schema({ threadId: id, history }, ['threadId']),
      ({ threadId, history }, service) => service.readControlHistory({ chatId: threadId, ...(history && { history }) })),
    create_thread: tool<{ projectId: string | null }>('create_thread',
      'Create one ordinary Kodex chat in the selected project root, or standalone with null. This does not send input and is not a replay-safe spawn.',
      schema({ projectId: nullableId }, ['projectId']), ({ projectId }, service) => service.createChat({ projectId })),
    send_thread_input: tool<{ threadId: string; text: string }>('send_thread_input',
      'Queue one text input in the explicitly selected ordinary Kodex chat using native follow-up semantics. This does not steer an active run. An uncertain result must be inspected, never automatically retried.',
      schema({ threadId: id, text: { type: 'string', minLength: 1, maxLength: 100_000, pattern: '\\S' } }, ['threadId', 'text']),
      ({ threadId, text }, service) => service.queue({ chatId: threadId, text })),
    rename_thread: tool<{ threadId: string; name: string }>('rename_thread', 'Rename an ordinary Kodex chat.',
      schema({ threadId: id, name: { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' } }, ['threadId', 'name']),
      ({ threadId, name }, service) => service.renameChat({ chatId: threadId, title: name })),
    pin_thread: tool<{ threadId: string; pinned: boolean; beforeThreadId?: string | null }>('pin_thread',
      'Change shared pinned membership/order without moving project or working directory. Unpin does not accept beforeThreadId.',
      schema({ threadId: id, pinned: { type: 'boolean' }, beforeThreadId: nullableId }, ['threadId', 'pinned']),
      ({ threadId, pinned, beforeThreadId }, service) => service.setChatPinned({ chatId: threadId, pinned,
        ...(beforeThreadId !== undefined ? { beforeChatId: beforeThreadId } : {}) })),
    archive_thread: tool<{ threadId: string }>('archive_thread', 'Archive an ordinary Kodex chat and retire its owned native descendants.',
      schema({ threadId: id }, ['threadId']), ({ threadId }, service) => service.archiveChat({ chatId: threadId })),
    interrupt_thread: tool<{ threadId: string }>('interrupt_thread', 'Stop the current native run of the explicitly selected Kodex chat.',
      schema({ threadId: id }, ['threadId']), ({ threadId }, service) => service.stop({ chatId: threadId })),
  };
}
