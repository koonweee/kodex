import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createSocketLink } from './socketLink';
import type { RouterClient } from '@orpc/server';
import type { ChatRouter } from '../../../../spikes/mastra-code-sdk/src/chat-router';
import { getApiBaseUrl } from '../api/client';

export type ChatClient = RouterClient<ChatRouter>;
export type ChatSnapshot = Awaited<ReturnType<ChatClient['openChat']>>;
export type CatalogSnapshot = Awaited<ReturnType<ChatClient['listChats']>>;
export type Chat = CatalogSnapshot['chats'][number];
export type HostInfo = Awaited<ReturnType<ChatClient['info']>>;
export const mastraClient: ChatClient = createORPCClient(createSocketLink(() => `${getApiBaseUrl()}/rpc`));
// Uploads use native multipart HTTP so large files cannot close the shared socket.
export const mastraUploadClient: Pick<ChatClient, 'uploadFile' | 'uploadImage'> = createORPCClient(new RPCLink({ url: () => `${getApiBaseUrl()}/rpc` }));
export const usesMastraBackend = import.meta.env.VITE_KODEX_BACKEND === 'mastra';
