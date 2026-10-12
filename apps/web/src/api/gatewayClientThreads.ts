import type { paths } from "./generated/schema";
import type {
  AppSurfaceBridgeRequest,
  AppSurfaceBridgeResponse,
  AppSurfaceSession,
  CreateThreadOptions,
  MarkThreadSeenRequest,
  SidebarThreadsResponse,
  ThreadDeliveryOptions,
  ThreadGoalUpdateRequest,
  ThreadListResponse,
  ThreadNotificationSettingsResponse,
  ThreadRead,
  ThreadSettingsResponse,
  ThreadSettingsUpdateRequest,
  ThreadSubagentListResponse,
  ThreadSummary,
  ThreadViewPresenceSnapshotRequest,
  ThreadViewResponse,
  UnreadBadgeResponse,
} from "./client";
import { unwrap, unwrapNoContent, type GatewayClientDependencies } from "./gatewayClientShared";

export function createGatewayThreads({
  api,
  compatibilityRequired,
  requestUrl,
  transportFetch,
}: GatewayClientDependencies) {
  async function listThreadsPage(
    projectId: string,
    options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ThreadListResponse> {
    return unwrap(
      api.GET("/v1/threads", {
        signal: options.signal,
        cache: "no-store",
        params: { query: { projectId, cursor: options.cursor ?? undefined, limit: options.limit ?? 100 } },
      }),
    );
  }
  async function getSidebarThreads(signal?: AbortSignal): Promise<SidebarThreadsResponse> {
    return unwrap(api.GET("/v1/sidebar/threads", { signal, cache: "no-store" }));
  }
  async function listChatThreadsPage(
    options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ThreadListResponse> {
    return unwrap(
      api.GET("/v1/chats/threads", {
        signal: options.signal,
        cache: "no-store",
        params: { query: { cursor: options.cursor ?? undefined, limit: options.limit ?? undefined } },
      }),
    );
  }
  async function createThread(projectId: string, options: CreateThreadOptions = {}): Promise<ThreadSummary> {
    const response = await unwrap(api.POST("/v1/threads", { body: { projectId, ...options } }));
    return response.thread;
  }
  async function createChatThread(
    firstMessageText: string,
    options: CreateThreadOptions = {},
  ): Promise<ThreadSummary> {
    const response = await unwrap(api.POST("/v1/chats/threads", { body: { firstMessageText, ...options } }));
    return response.thread;
  }
  function threadDeliveryQuery(options: ThreadDeliveryOptions) {
    return { includeDebugEvents: options.includeDebugEvents || undefined, includeCommandOutputs: options.includeCommandOutputs || undefined };
  }
  async function attachThread(threadId: string, signal?: AbortSignal, deliveryOptions: ThreadDeliveryOptions = {}): Promise<ThreadViewResponse> {
    return unwrap(api.POST("/v1/threads/{threadId}/attach", { params: { path: { threadId }, query: threadDeliveryQuery(deliveryOptions) }, signal }));
  }
  async function getThreadDetail(threadId: string, signal?: AbortSignal, deliveryOptions: ThreadDeliveryOptions = {}): Promise<ThreadViewResponse> {
    return unwrap(api.GET("/v1/threads/{threadId}", { params: { path: { threadId }, query: threadDeliveryQuery(deliveryOptions) }, cache: "no-store", signal }));
  }
  async function getThreadTimelinePage(
    threadId: string,
    options: ThreadDeliveryOptions & { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ThreadViewResponse> {
    return unwrap(
      api.GET("/v1/threads/{threadId}/timeline/pages", {
        params: {
          path: { threadId },
          query: { cursor: options.cursor ?? undefined, limit: options.limit ?? undefined, ...threadDeliveryQuery(options) },
        },
        signal: options.signal,
      }),
    );
  }
  async function listThreadSubagents(
    threadId: string,
    { signal, ...query }: NonNullable<paths["/v1/threads/{threadId}/subagents"]["get"]["parameters"]["query"]> & { signal?: AbortSignal } = {},
  ): Promise<ThreadSubagentListResponse> {
    return unwrap(
      api.GET("/v1/threads/{threadId}/subagents", { params: { path: { threadId }, query }, cache: "no-store", signal }),
    );
  }
  async function getThreadAppSurface(threadId: string, signal?: AbortSignal): Promise<AppSurfaceSession | null> {
    const response = await unwrap(
      api.GET("/v1/threads/{threadId}/app-surface", { params: { path: { threadId } }, signal, cache: "no-store" }),
    );
    return response.session ?? null;
  }
  async function fetchAppSurfaceDocument(documentUrl: string, signal?: AbortSignal): Promise<string> {
    const route = appSurfaceDocumentRoute(documentUrl);
    const response = await transportFetch(requestUrl(route), {
      headers: { Accept: "text/html" },
      signal,
    });
    if (!response.ok) throw new Error(`App surface document failed to load. (${response.status})`);
    return response.text();
  }
  async function callAppSurfaceBridge(
    sessionId: string,
    request: AppSurfaceBridgeRequest,
  ): Promise<AppSurfaceBridgeResponse> {
    return unwrap(
      api.POST("/v1/app-surfaces/{sessionId}/bridge", {
        params: { path: { sessionId } },
        body: request,
      }),
    );
  }
  async function archiveThread(threadId: string): Promise<void> {
    await unwrap(api.POST("/v1/threads/{threadId}/archive", { params: { path: { threadId } } }));
  }
  async function renameThread(threadId: string, name: string): Promise<ThreadSummary> {
    const response = await unwrap(
      api.PATCH("/v1/threads/{threadId}/name", { params: { path: { threadId } }, body: { name } }),
    );
    return response.thread;
  }
  async function setThreadNotificationsEnabled(
    threadId: string,
    enabled: boolean,
  ): Promise<ThreadNotificationSettingsResponse> {
    return unwrap(
      api.PATCH("/v1/threads/{threadId}/notifications", {
        params: { path: { threadId } },
        body: { enabled },
      }),
    );
  }
  async function getThreadSettings(threadId: string, signal?: AbortSignal): Promise<ThreadSettingsResponse> {
    return unwrap(api.GET("/v1/threads/{threadId}/settings", {
      params: { path: { threadId } }, signal, cache: "no-store",
    }));
  }
  async function getThreadGoal(threadId: string, signal?: AbortSignal) {
    return unwrap(api.GET("/v1/threads/{threadId}/goal", {
      params: { path: { threadId } }, signal, cache: "no-store",
    }));
  }
  async function updateThreadGoal(threadId: string, input: ThreadGoalUpdateRequest) {
    return unwrap(api.PATCH("/v1/threads/{threadId}/goal", {
      params: { path: { threadId } }, body: input,
    }));
  }
  async function clearThreadGoal(threadId: string) {
    return unwrap(api.DELETE("/v1/threads/{threadId}/goal", {
      params: { path: { threadId } },
    }));
  }
  async function updateThreadSettings(
    threadId: string,
    input: ThreadSettingsUpdateRequest,
  ): Promise<void> {
    await unwrapNoContent(
      api.PATCH("/v1/threads/{threadId}/settings", {
        params: { path: { threadId } },
        body: input,
      }),
    );
  }
  async function setThreadPinned(threadId: string, pinned: boolean, beforeThreadId?: string | null): Promise<void> {
    await unwrapNoContent(api.POST("/v1/threads/{threadId}/pin", {
      params: { path: { threadId } }, body: { pinned, ...(beforeThreadId !== undefined ? { beforeThreadId } : {}) },
    }));
  }
  async function listPinnedThreads({ cursor, signal }: { cursor?: string | null; signal?: AbortSignal } = {}): Promise<ThreadListResponse> {
    return unwrap(api.GET("/v1/pinned-threads", {
      params: { query: { ...(cursor ? { cursor } : {}), limit: 100 } }, signal, cache: "no-store",
    }));
  }
  async function getUnreadBadge(signal?: AbortSignal): Promise<UnreadBadgeResponse> {
    return unwrap(api.GET("/v1/threads/unread-badge", { signal, cache: "no-store" }));
  }
  async function markThreadSeen(threadId: string, body: MarkThreadSeenRequest): Promise<ThreadRead> {
    return unwrap(api.POST("/v1/threads/{threadId}/seen", { params: { path: { threadId } }, body }));
  }
  async function replaceThreadViewPresence(
    request: ThreadViewPresenceSnapshotRequest,
  ): Promise<void> {
    await unwrapNoContent(
      api.PUT("/v1/thread-view-presence", {
        body: request,
      }),
    );
  }
  function sendThreadViewPresenceSnapshotBeacon(request: ThreadViewPresenceSnapshotRequest): boolean {
    if (compatibilityRequired()) {
      return false;
    }
    void transportFetch(requestUrl("/v1/thread-view-presence"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      keepalive: true,
    }).catch(() => undefined);
    return true;
  }

  return {
    listThreadsPage,
    getSidebarThreads,
    listChatThreadsPage,
    createThread,
    createChatThread,
    attachThread,
    getThreadDetail,
    getThreadTimelinePage,
    listThreadSubagents,
    getThreadAppSurface,
    fetchAppSurfaceDocument,
    callAppSurfaceBridge,
    archiveThread,
    renameThread,
    setThreadNotificationsEnabled,
    getThreadSettings,
    getThreadGoal,
    updateThreadGoal,
    clearThreadGoal,
    updateThreadSettings,
    setThreadPinned,
    listPinnedThreads,
    getUnreadBadge,
    markThreadSeen,
    replaceThreadViewPresence,
    sendThreadViewPresenceSnapshotBeacon,
  };
}

function appSurfaceDocumentRoute(documentUrl: string): string {
  const url = new URL(documentUrl, "https://kodex.invalid");
  if (url.origin !== "https://kodex.invalid" || !/^\/v1\/app-surfaces\/[^/]+\/document$/.test(url.pathname)) {
    throw new Error("App surface document URL is outside the executor API.");
  }
  return `${url.pathname}${url.search}`;
}
