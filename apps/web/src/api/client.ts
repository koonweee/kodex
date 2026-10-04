import createClient from "openapi-fetch";

import type { components, paths } from "./generated/schema";

export type AccountLoginCompleted = components["schemas"]["AccountLoginCompleted"];
export type LoginStartResponse = components["schemas"]["LoginStartResponse"];
export type AccountResponse = components["schemas"]["AccountResponse"];
export type Approval = components["schemas"]["Approval"];
export type ApprovalListResponse = components["schemas"]["ApprovalListResponse"];
export type ApprovalResponse = Record<string, unknown>;
export type Automation = components["schemas"]["AutomationDto"];
export type AutomationCreateRequest = components["schemas"]["AutomationCreateRequest"];
export type AutomationUpdateRequest = components["schemas"]["AutomationUpdateRequest"];
export type Capabilities = components["schemas"]["CapabilitiesResponse"];
export type ComposerSettingsResponse = components["schemas"]["ComposerSettingsResponse"];
export type ComposerSettingsUpdateRequest = components["schemas"]["ComposerSettingsUpdateRequest"];
export type ComposerSettingsUpdateResponse = components["schemas"]["ComposerSettingsUpdateResponse"];
export type NativeConfigWriteTarget = components["schemas"]["NativeConfigWriteTarget"];
export type NativeConfigWriteResult = components["schemas"]["NativeConfigWriteResult"];
export type EventEnvelope = components["schemas"]["EventEnvelope"];
export type AppSurfaceBridgeRequest = components["schemas"]["AppSurfaceBridgeRequest"];
export type AppSurfaceBridgeResponse = components["schemas"]["AppSurfaceBridgeResponse"];
export type AppSurfaceSession = components["schemas"]["AppSurfaceSessionDto"];
export type KodexControlPluginInstallResponse = components["schemas"]["KodexControlPluginInstallResponse"];
export type KodexControlPluginStatusResponse = components["schemas"]["KodexControlPluginStatusResponse"];
export type ConfiguredMcpServer = components["schemas"]["ConfiguredMcpServer"];
export type ConfiguredMcpServerListResponse = components["schemas"]["ConfiguredMcpServerListResponse"];
export type McpConfigMutationResponse = components["schemas"]["McpConfigMutationResponse"];
export type McpOAuthLoginResponse = components["schemas"]["McpOAuthLoginResponse"];
export type McpResource = components["schemas"]["McpResource"];
export type McpResourceReadResponse = components["schemas"]["McpResourceReadResponse"];
export type McpServerInstallRequest = components["schemas"]["McpServerInstallRequest"];
export type McpServerUpdateRequest = components["schemas"]["McpServerUpdateRequest"];
export type McpReloadResponse = components["schemas"]["McpReloadResponse"];
export type McpServerListResponse = components["schemas"]["McpServerListResponse"];
export type McpServerStatus = components["schemas"]["McpServerStatus"];
export type ModelSummary = components["schemas"]["ModelSummary"];
export type PendingTimelineRequestSummary = components["schemas"]["PendingTimelineRequestSummary"];
export type PermissionProfileSummary = components["schemas"]["PermissionProfileSummary"];
export type Project = components["schemas"]["Project"];
export type CreateProjectRequest = components["schemas"]["CreateProjectRequest"];
export type UpdateProjectRequest = components["schemas"]["UpdateProjectRequest"];
export type QueuedInput = components["schemas"]["QueuedInput"];
export type RateLimitSnapshot = components["schemas"]["RateLimitSnapshot"];
export type RateLimitWindow = components["schemas"]["RateLimitWindow"];
export type RateLimitsResponse = components["schemas"]["RateLimitsResponse"];
export type SkillMetadata = components["schemas"]["SkillMetadata"];
export type SkillsCatalogResponse = components["schemas"]["SkillsCatalogResponse"];
export type ThreadRead = components["schemas"]["ThreadRead"];
export type ThreadReadStateUpdate = components["schemas"]["ThreadReadStateUpdate"];
export type ThreadSettingsUpdateRequest = components["schemas"]["ThreadSettingsUpdateRequest"];
export type ThreadSettingsResponse = components["schemas"]["ThreadSettingsResponse"];
export type ThreadNotificationSettingsResponse = components["schemas"]["ThreadNotificationSettingsResponse"];
export type ThreadViewPresenceSnapshotRequest = components["schemas"]["ThreadViewPresenceSnapshotRequest"];
export type ThreadAttachResponse = components["schemas"]["ThreadAttachResponse"];
export type ThreadListResponse = components["schemas"]["ThreadListResponse"];
export type SidebarThreadSummary = components["schemas"]["SidebarThreadSummary"];
export type SidebarThreadsResponse = components["schemas"]["SidebarThreadsResponse"];
export type ThreadViewResponse = components["schemas"]["ThreadViewResponse"];
export type ThreadViewThreadSummary = components["schemas"]["ThreadViewThreadSummary"];
export type ThreadSubagentSummary = components["schemas"]["ThreadSubagentSummary"];
export type ThreadSubagentListResponse = components["schemas"]["ThreadSubagentListResponse"];
export type TextElement = components["schemas"]["TextElement"];
export type ThreadSection = components["schemas"]["ThreadSection"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadTimelineFileChangeEntry = components["schemas"]["ThreadTimelineFileChangeEntry"];
export type ThreadTimelineRow = components["schemas"]["ThreadTimelineRow"];
export type ThreadTimelineSnapshot = components["schemas"]["ThreadTimelineSnapshot"];
export type ThreadTimelineSnapshotItem = components["schemas"]["ThreadTimelineSnapshotItem"];
export type ThreadTimelineWorkDetailRow = components["schemas"]["ThreadTimelineWorkDetailRow"];
export type ThreadTimelineWindowPage = components["schemas"]["ThreadTimelineWindowPage"];
export type ThreadInputResponse = components["schemas"]["ThreadInputResponse"];
export type ThreadInterruptCurrentResponse = components["schemas"]["ThreadInterruptCurrentResponse"];
export type ThreadCompactResponse = components["schemas"]["ThreadCompactResponse"];
export type TimelineSkillMention = components["schemas"]["TimelineSkillMention"];
export type ThreadViewPatch = components["schemas"]["ThreadViewPatch"];
export type UserInput = components["schemas"]["UserInput"];
export type ImageUpload = components["schemas"]["ImageUpload"];
export type TimelineFileAttachment = components["schemas"]["TimelineFileAttachment"];
export type CreateThreadOptions = Omit<components["schemas"]["CreateThreadRequest"], "payload" | "projectId">;
export type NotificationStatusResponse = components["schemas"]["NotificationStatusResponse"];
export type PushSubscriptionUpsertResponse = components["schemas"]["PushSubscriptionUpsertResponse"];
export type CurrentPushSubscriptionStatusResponse = components["schemas"]["CurrentPushSubscriptionResponse"];
export type TestNotificationResponse = components["schemas"]["TestNotificationResponse"];
export type CreateTerminalSession = components["schemas"]["CreateTerminalSession"];
export type TerminalDeleteResponse = components["schemas"]["TerminalDeleteResponse"];
export type TerminalSessionInfo = components["schemas"]["TerminalSessionInfo"];

type GatewayErrorBody = Partial<components["schemas"]["ApiErrorBody"]>;

export class GatewayRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

const api = createClient<paths>({
  baseUrl: getApiBaseUrl(),
  fetch: (request) => globalThis.fetch(request),
});

function getApiBaseUrl(): string {
  if (import.meta.env.VITE_KODEX_API_BASE_URL) {
    return import.meta.env.VITE_KODEX_API_BASE_URL;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "";
}

export function terminalWebSocketUrl(terminalId: string): string {
  const route = `/v1/terminals/${encodeURIComponent(terminalId)}/ws`;
  const baseUrl = getApiBaseUrl();
  const url = new URL(route, baseUrl || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function filePreviewUrl(threadId: string, path: string): string {
  const route = `/v1/threads/${encodeURIComponent(threadId)}/files/preview?path=${encodeURIComponent(path)}`;
  const apiBaseUrl = getApiBaseUrl();
  return apiBaseUrl ? `${apiBaseUrl}${route}` : route;
}

export function skillIconUrl(path: string): string {
  const route = `/v1/skills/icon?path=${encodeURIComponent(path)}`;
  const apiBaseUrl = getApiBaseUrl();
  return apiBaseUrl ? `${apiBaseUrl}${route}` : route;
}

export async function fetchThreadFilePreview(threadId: string, path: string): Promise<string> {
  const response = await globalThis.fetch(filePreviewUrl(threadId, path));
  if (!response.ok) {
    throw new Error(`Unable to preview file: ${response.status}`);
  }
  return response.text();
}

export async function getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  return unwrap(api.GET("/v1/capabilities", { cache: "no-store", signal }));
}

export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const response = await unwrap(api.GET("/v1/terminals"));
  return response.terminals;
}

export async function createTerminalSession(request: CreateTerminalSession = {}): Promise<TerminalSessionInfo> {
  const response = await unwrap(api.POST("/v1/terminals", { body: request }));
  return response.terminal;
}

export async function deleteTerminalSession(terminalId: string): Promise<TerminalDeleteResponse> {
  return unwrap(api.DELETE("/v1/terminals/{terminalId}", { params: { path: { terminalId } } }));
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const response = await unwrap(api.GET("/v1/projects", { signal, cache: "no-store" }));
  return response.projects;
}

export async function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
  return unwrap(api.GET("/v1/projects/{projectId}", { params: { path: { projectId } }, cache: "no-store", signal }));
}

export async function createProject(input: CreateProjectRequest): Promise<Project> {
  return unwrap(api.POST("/v1/projects", { body: input }));
}

export async function updateProject(projectId: string, input: UpdateProjectRequest): Promise<Project> {
  return unwrap(api.PATCH("/v1/projects/{projectId}", { params: { path: { projectId } }, body: input }));
}

export async function deleteProject(projectId: string): Promise<void> {
  await unwrapNoContent(api.DELETE("/v1/projects/{projectId}", { params: { path: { projectId } } }));
}

export async function moveProject(projectId: string, beforeProjectId: string | null): Promise<void> {
  await unwrapNoContent(api.POST("/v1/projects/{projectId}/move", { params: { path: { projectId } }, body: { beforeProjectId } }));
}

export async function assignThreadProject(threadId: string, projectId: string | null): Promise<void> {
  await unwrap(api.PATCH("/v1/threads/{threadId}/project", { params: { path: { threadId } }, body: { projectId } }));
}

export async function listThreadsPage(
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

export async function getSidebarThreads(signal?: AbortSignal): Promise<SidebarThreadsResponse> {
  return unwrap(api.GET("/v1/sidebar/threads", { signal, cache: "no-store" }));
}

export async function listChatThreadsPage(
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

export async function createThread(projectId: string, options: CreateThreadOptions = {}): Promise<ThreadSummary> {
  const response = await unwrap(api.POST("/v1/threads", { body: { projectId, ...options } }));
  return response.thread;
}

export async function createChatThread(
  firstMessageText: string,
  options: CreateThreadOptions = {},
): Promise<ThreadSummary> {
  const response = await unwrap(api.POST("/v1/chats/threads", { body: { firstMessageText, ...options } }));
  return response.thread;
}

export async function attachThread(threadId: string): Promise<ThreadAttachResponse> {
  return unwrap(api.POST("/v1/threads/{threadId}/attach", { params: { path: { threadId } } }));
}

export async function getThreadDetail(threadId: string, signal?: AbortSignal): Promise<ThreadViewResponse> {
  return unwrap(api.GET("/v1/threads/{threadId}", { params: { path: { threadId } }, cache: "no-store", signal }));
}

export async function getThreadTimelinePage(
  threadId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ThreadViewResponse> {
  return unwrap(
    api.GET("/v1/threads/{threadId}/timeline/pages", {
      params: {
        path: { threadId },
        query: { cursor: options.cursor ?? undefined, limit: options.limit ?? undefined },
      },
    }),
  );
}

export async function listThreadSubagents(
  threadId: string,
  { signal, ...query }: NonNullable<paths["/v1/threads/{threadId}/subagents"]["get"]["parameters"]["query"]> & { signal?: AbortSignal } = {},
): Promise<ThreadSubagentListResponse> {
  return unwrap(
    api.GET("/v1/threads/{threadId}/subagents", { params: { path: { threadId }, query }, cache: "no-store", signal }),
  );
}

export async function getThreadAppSurface(threadId: string): Promise<AppSurfaceSession | null> {
  const response = await unwrap(
    api.GET("/v1/threads/{threadId}/app-surface", { params: { path: { threadId } } }),
  );
  return response.session ?? null;
}

export async function callAppSurfaceBridge(
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

export async function archiveThread(threadId: string): Promise<void> {
  await unwrap(api.POST("/v1/threads/{threadId}/archive", { params: { path: { threadId } } }));
}

export async function renameThread(threadId: string, name: string): Promise<ThreadSummary> {
  const response = await unwrap(
    api.PATCH("/v1/threads/{threadId}/name", { params: { path: { threadId } }, body: { name } }),
  );
  return response.thread;
}

export async function setThreadNotificationsEnabled(
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

export async function getThreadSettings(threadId: string, signal?: AbortSignal): Promise<ThreadSettingsResponse> {
  return unwrap(api.GET("/v1/threads/{threadId}/settings", {
    params: { path: { threadId } }, signal, cache: "no-store",
  }));
}

export async function updateThreadSettings(
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

export async function createThreadSection(name: string): Promise<ThreadSection> {
  const response = await unwrap(api.POST("/v1/thread-sections", { body: { name } }));
  return response.section;
}

export async function renameThreadSection(sectionId: string, name: string): Promise<ThreadSection> {
  const response = await unwrap(api.PATCH("/v1/thread-sections/{sectionId}", { params: { path: { sectionId } }, body: { name } }));
  return response.section;
}

export async function deleteThreadSection(sectionId: string): Promise<void> {
  await unwrapNoContent(api.DELETE("/v1/thread-sections/{sectionId}", { params: { path: { sectionId } } }));
}

export async function moveThreadToSection(threadId: string, sectionId: string | null, beforeThreadId?: string | null): Promise<void> {
  await unwrapNoContent(api.POST("/v1/threads/{threadId}/section", {
    params: { path: { threadId } }, body: { sectionId, ...(beforeThreadId !== undefined ? { beforeThreadId } : {}) },
  }));
}

export async function listSectionThreads(sectionId: string, { cursor, signal }: { cursor?: string | null; signal?: AbortSignal } = {}): Promise<ThreadListResponse> {
  return unwrap(api.GET("/v1/thread-sections/{sectionId}/threads", {
    params: { path: { sectionId }, query: { ...(cursor ? { cursor } : {}), limit: 100 } }, signal, cache: "no-store",
  }));
}

export async function markThreadSeen(threadId: string, seenCompletedAgentTurnSeq?: number): Promise<ThreadRead> {
  const body =
    seenCompletedAgentTurnSeq === undefined
      ? {}
      : {
          seenCompletedAgentTurnSeq,
        };
  return unwrap(api.POST("/v1/threads/{threadId}/seen", { params: { path: { threadId } }, body }));
}

export async function replaceThreadViewPresence(
  request: ThreadViewPresenceSnapshotRequest,
): Promise<void> {
  await unwrapNoContent(
    api.PUT("/v1/thread-view-presence", {
      body: request,
    }),
  );
}

function threadViewPresenceSnapshotUrl(): string {
  const route = "/v1/thread-view-presence";
  const apiBaseUrl = getApiBaseUrl();
  return apiBaseUrl ? `${apiBaseUrl}${route}` : route;
}

export function sendThreadViewPresenceSnapshotBeacon(request: ThreadViewPresenceSnapshotRequest): boolean {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  const body = new Blob([JSON.stringify(request)], { type: "application/json" });
  return navigator.sendBeacon(threadViewPresenceSnapshotUrl(), body);
}

export async function getNotificationStatus(): Promise<NotificationStatusResponse> {
  return unwrap(api.GET("/v1/notifications/status"));
}

export async function getCurrentPushSubscriptionStatus(
  endpoint: string,
): Promise<CurrentPushSubscriptionStatusResponse> {
  return unwrap(api.GET("/v1/notifications/subscription/current", { params: { query: { endpoint } } }));
}

export async function upsertPushSubscription(
  subscription: PushSubscription,
  userAgent: string | null = typeof navigator === "undefined" ? null : navigator.userAgent,
): Promise<PushSubscriptionUpsertResponse> {
  const value = subscription.toJSON();
  const endpoint = value.endpoint;
  const auth = value.keys?.auth;
  const p256dh = value.keys?.p256dh;
  if (!endpoint || !auth || !p256dh) {
    throw new Error("Push subscription is missing endpoint or keys");
  }
  return unwrap(
    api.POST("/v1/notifications/subscriptions", {
      body: {
        endpoint,
        keys: {
          auth,
          p256dh,
        },
        userAgent,
      },
    }),
  );
}

export async function deleteCurrentPushSubscription(endpoint: string): Promise<CurrentPushSubscriptionStatusResponse> {
  return unwrap(api.DELETE("/v1/notifications/subscription/current", { params: { query: { endpoint } } }));
}

export async function sendTestNotification(): Promise<TestNotificationResponse> {
  return unwrap(api.POST("/v1/notifications/test"));
}

export async function submitThreadInput(
  threadId: string,
  input: UserInput[],
  attachments: TimelineFileAttachment[] = [],
): Promise<ThreadInputResponse> {
  return unwrap(
    api.POST("/v1/threads/{threadId}/input", {
      params: { path: { threadId } },
      body: { input, ...(attachments.length > 0 ? { attachments } : {}) },
    }),
  );
}

export async function compactThread(threadId: string): Promise<ThreadCompactResponse> {
  return unwrap(
    api.POST("/v1/threads/{threadId}/compact", {
      params: { path: { threadId } },
    }),
  );
}

export async function listQueuedInputs(threadId: string): Promise<QueuedInput[]> {
  const response = await unwrap(
    api.GET("/v1/threads/{threadId}/queued-inputs", { params: { path: { threadId } } }),
  );
  return response.queuedInputs;
}

export async function createQueuedInput(
  threadId: string,
  input: UserInput[],
  attachments: TimelineFileAttachment[] = [],
): Promise<QueuedInput> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/queued-inputs", {
      params: { path: { threadId } },
      body: { input, ...(attachments.length > 0 ? { attachments } : {}) },
    }),
  );
  return response.queuedInput;
}

export async function retryQueuedInput(threadId: string, queueId: string): Promise<QueuedInput> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/queued-inputs/{queueId}/retry", {
      params: { path: { threadId, queueId } },
    }),
  );
  return response.queuedInput;
}

export async function steerQueuedInput(threadId: string, queueId: string): Promise<QueuedInput> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/queued-inputs/{queueId}/steer", {
      params: { path: { threadId, queueId } },
    }),
  );
  return response.queuedInput;
}

export async function deleteQueuedInput(threadId: string, queueId: string): Promise<void> {
  await unwrap(
    api.DELETE("/v1/threads/{threadId}/queued-inputs/{queueId}", {
      params: { path: { threadId, queueId } },
    }),
  );
}

export async function listAutomations(threadId?: string): Promise<Automation[]> {
  const response = await unwrap(
    api.GET("/v1/automations", {
      params: threadId ? { query: { threadId } } : undefined,
    }),
  );
  return response.automations;
}

export async function createAutomation(request: AutomationCreateRequest): Promise<Automation> {
  const response = await unwrap(api.POST("/v1/automations", { body: request }));
  return response.automation;
}

export async function updateAutomation(
  automationId: string,
  request: AutomationUpdateRequest,
): Promise<Automation> {
  const response = await unwrap(
    api.PATCH("/v1/automations/{automationId}", {
      params: { path: { automationId } },
      body: request,
    }),
  );
  return response.automation;
}

export async function pauseAutomation(automationId: string): Promise<Automation> {
  const response = await unwrap(
    api.POST("/v1/automations/{automationId}/pause", {
      params: { path: { automationId } },
    }),
  );
  return response.automation;
}

export async function resumeAutomation(automationId: string): Promise<Automation> {
  const response = await unwrap(
    api.POST("/v1/automations/{automationId}/resume", {
      params: { path: { automationId } },
    }),
  );
  return response.automation;
}

export async function deleteAutomation(automationId: string): Promise<void> {
  await unwrap(
    api.DELETE("/v1/automations/{automationId}", {
      params: { path: { automationId } },
    }),
  );
}

export async function interruptCurrentTurn(threadId: string): Promise<ThreadInterruptCurrentResponse> {
  return unwrap(api.POST("/v1/threads/{threadId}/interrupt-current", { params: { path: { threadId } } }));
}

export async function uploadImages(files: File[]): Promise<ImageUpload[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("images", file);
  }
  const response = await fetch(`${getApiBaseUrl()}/v1/uploads/images`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const body = (await response.json()) as components["schemas"]["ImageUploadResponse"];
  return body.images;
}

export async function uploadFiles(threadId: string, files: File[]): Promise<TimelineFileAttachment[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const response = await fetch(`${getApiBaseUrl()}/v1/threads/${encodeURIComponent(threadId)}/uploads/files`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const body = (await response.json()) as components["schemas"]["FileUploadResponse"];
  return body.files;
}

export async function listPendingApprovals(signal?: AbortSignal): Promise<ApprovalListResponse> {
  return unwrap(api.GET("/v1/approvals", { signal, cache: "no-store" }));
}

export async function decideApproval(approvalId: string, decision: ApprovalResponse): Promise<Approval> {
  return unwrap(
    api.POST("/v1/approvals/{approvalId}/decision", {
      params: { path: { approvalId } },
      body: { decision },
    }),
  );
}

export async function getAccount(signal?: AbortSignal): Promise<AccountResponse> {
  return unwrap(api.GET("/v1/account", { signal, cache: "no-store" }));
}

export async function startLogin() {
  return unwrap(api.POST("/v1/account/login"));
}

export async function cancelLogin(loginId: string): Promise<void> {
  await unwrap(api.POST("/v1/account/login/{loginId}/cancel", { params: { path: { loginId } } }));
}

export async function logout(): Promise<void> {
  await unwrap(api.POST("/v1/account/logout"));
}

export async function getRateLimits(signal?: AbortSignal): Promise<RateLimitsResponse> {
  return unwrap(api.GET("/v1/account/rate-limits", { signal, cache: "no-store" }));
}

export async function listModels(): Promise<ModelSummary[]> {
  const response = await unwrap(api.GET("/v1/models", { params: { query: { includeHidden: false } } }));
  return response.models.filter((model) => !model.hidden);
}

export async function getKodexControlPluginStatus(): Promise<KodexControlPluginStatusResponse> {
  return unwrap(api.GET("/v1/kodex-control-plugin"));
}

export async function installKodexControlPlugin(): Promise<KodexControlPluginInstallResponse> {
  return unwrap(api.POST("/v1/kodex-control-plugin/install"));
}

export async function listMcpServers(signal?: AbortSignal): Promise<McpServerListResponse> {
  return unwrap(api.GET("/v1/mcp/servers", { signal, cache: "no-store", params: { query: { detail: "full" } } }));
}

export async function listConfiguredMcpServers(signal?: AbortSignal): Promise<ConfiguredMcpServerListResponse> {
  return unwrap(api.GET("/v1/mcp/configured-servers", { signal, cache: "no-store" }));
}

export async function addMcpServer(request: McpServerInstallRequest): Promise<McpConfigMutationResponse> {
  return unwrap(api.POST("/v1/mcp/servers", { body: request }));
}

export async function updateMcpServer(
  server: string,
  request: McpServerUpdateRequest,
): Promise<McpConfigMutationResponse> {
  return unwrap(api.PATCH("/v1/mcp/servers/{server}", { params: { path: { server } }, body: request }));
}

export async function setMcpServerEnabled(server: string, enabled: boolean, writeTarget: NativeConfigWriteTarget): Promise<McpConfigMutationResponse> {
  return unwrap(
    api.PATCH("/v1/mcp/servers/{server}/enabled", {
      params: { path: { server } },
      body: { enabled, writeTarget },
    }),
  );
}

export async function removeMcpServer(server: string, writeTarget: NativeConfigWriteTarget): Promise<McpConfigMutationResponse> {
  return unwrap(api.DELETE("/v1/mcp/servers/{server}", { params: { path: { server } }, body: { writeTarget } }));
}

export async function reloadMcpServers(): Promise<McpReloadResponse> {
  return unwrap(api.POST("/v1/mcp/reload"));
}

export async function startMcpOAuthLogin(server: string): Promise<McpOAuthLoginResponse> {
  return unwrap(
    api.POST("/v1/mcp/servers/{server}/oauth-login", {
      params: { path: { server } },
      body: {},
    }),
  );
}

export async function readMcpResource(server: string, uri: string): Promise<McpResourceReadResponse> {
  return unwrap(
    api.GET("/v1/mcp/servers/{server}/resources/read", {
      params: { path: { server }, query: { uri } },
    }),
  );
}

export async function listSkills(cwd?: string | null, forceReload = false): Promise<SkillsCatalogResponse> {
  return unwrap(
    api.GET("/v1/skills", {
      params: { query: { cwd: cwd ?? undefined, forceReload } },
    }),
  );
}

export async function listPermissionProfiles(cwd?: string | null, signal?: AbortSignal): Promise<PermissionProfileSummary[]> {
  const response = await unwrap(
    api.GET("/v1/permission-profiles", {
      signal, cache: "no-store",
      params: { query: { cwd: cwd ?? undefined } },
    }),
  );
  return response.profiles;
}

export async function getComposerSettings(projectId?: string | null, cwd?: string | null, signal?: AbortSignal): Promise<ComposerSettingsResponse> {
  return unwrap(
    api.GET("/v1/composer-settings", { signal, cache: "no-store", params: { query: { projectId: projectId ?? undefined, cwd: cwd ?? undefined } } }),
  );
}

export async function persistComposerSettings(input: ComposerSettingsUpdateRequest): Promise<ComposerSettingsUpdateResponse> {
  return unwrap(api.PATCH("/v1/composer-settings", { body: input }));
}

async function unwrap<T>(request: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (error || data === undefined) {
    throw new GatewayRequestError(gatewayErrorMessage(error), response?.status, isGatewayErrorBody(error) ? error.code : undefined);
  }
  return data;
}

async function unwrapNoContent(request: Promise<{ error?: unknown; response?: Response }>): Promise<void> {
  const { error, response } = await request;
  if (error) {
    throw new GatewayRequestError(gatewayErrorMessage(error), response?.status, isGatewayErrorBody(error) ? error.code : undefined);
  }
}

function gatewayErrorMessage(error: unknown): string {
  if (isGatewayErrorBody(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Gateway request failed";
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    return gatewayErrorMessage((await response.clone().json()) as unknown);
  } catch {
    return "Gateway request failed";
  }
}

function isGatewayErrorBody(error: unknown): error is GatewayErrorBody {
  return typeof error === "object" && error !== null && "message" in error;
}
