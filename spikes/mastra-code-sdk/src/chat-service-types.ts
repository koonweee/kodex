import type { ChatPushOptions } from './chat-push.js';
import type { NativeSession, ProjectRuntime } from './runtime.js';
import type { RuntimeBinding } from './product-registry.js';
import type { createSessionProjection } from './transport.js';
import type { createChatQueue } from './chat-queue.js';
import type { CatalogChat } from './chat-activity.js';
import type { ChatReadState } from './chat-read-state.js';
import type { Chat, ChatProjectOptions, PinnedDescendant } from './chat-projects.js';
import type { ProductProject } from './product-registry.js';
import type { SpikeProfile } from './profile.js';
import type { NativePrompt, PromptResponse } from './chat-prompts.js';
import type { ChatSettings } from './chat-settings.js';
import type { ChatQueueInput, ChatQueueSnapshot } from './chat-queue.js';
import type { NativeGoal } from './chat-goals.js';
import type { SessionSnapshot } from './transport.js';

export interface CatalogSnapshot { epoch: string; revision: number; projects: ProductProject[]; chats: Array<CatalogChat & { readState: ChatReadState }>; pinnedChatIds: string[]; pinnedDescendants: Array<PinnedDescendant & { isRunning: boolean; readState: ChatReadState }>; archivedChatIds: string[] }
export interface ChatSnapshot extends SessionSnapshot { prompts: NativePrompt[]; chat: Chat; error: string | null; settings: ChatSettings; queue: ChatQueueSnapshot; goal: NativeGoal | null; readState: ChatReadState }
export interface ChatSeenSelection { chatId: string; epoch: string; revision: number; runId: string }
export type ChatPromptResponse = PromptResponse & { chatId: string };
export interface QueuedSelection { chatId: string; epoch: string; revision: number; id: string }
export interface QueuedEdit extends QueuedSelection { input: ChatQueueInput }
export interface QueuedOrder { chatId: string; epoch: string; revision: number; ids: string[] }
export interface ChatServiceOptions extends ChatProjectOptions { profile: SpikeProfile; instanceId: string; push?: ChatPushOptions }

export interface ChatHandle {
  binding: RuntimeBinding;
  runtime: ProjectRuntime;
  session: NativeSession;
  projection: ReturnType<typeof createSessionProjection>;
  queue: ReturnType<typeof createChatQueue>;
  revision: number;
  error: string | null;
  unsubscribe: () => void;
  observers: AbortController;
}
