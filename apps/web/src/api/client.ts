import createClient from "openapi-fetch";

import type { components, paths } from "./generated/schema";

export type AccountResponse = components["schemas"]["AccountResponse"];
export type Approval = components["schemas"]["Approval"];
export type ApprovalResponse = Record<string, unknown>;
export type Automation = components["schemas"]["AutomationDto"];
export type AutomationCreateRequest = components["schemas"]["AutomationCreateRequest"];
export type AutomationUpdateRequest = components["schemas"]["AutomationUpdateRequest"];
export type Capabilities = components["schemas"]["CapabilitiesResponse"];
export type ComposerSettingsResponse = components["schemas"]["ComposerSettingsResponse"];
export type ComposerSettingsUpdateRequest = components["schemas"]["ComposerSettingsUpdateRequest"];
export type EventEnvelope = components["schemas"]["EventEnvelope"];
export type LoginStartResponse = components["schemas"]["LoginStartResponse"];
export type KodexControlPluginInstallResponse = components["schemas"]["KodexControlPluginInstallResponse"];
export type KodexControlPluginStatusResponse = components["schemas"]["KodexControlPluginStatusResponse"];
export type ConfiguredMcpServer = components["schemas"]["ConfiguredMcpServer"];
export type ConfiguredMcpServerListResponse = components["schemas"]["ConfiguredMcpServerListResponse"];
export type McpConfigMutationResponse = components["schemas"]["McpConfigMutationResponse"];
export type McpOAuthLoginResponse = components["schemas"]["McpOAuthLoginResponse"];
export type McpResource = components["schemas"]["McpResource"];
export type McpResourceReadResponse = components["schemas"]["McpResourceReadResponse"];
export type McpServerInstallRequest = components["schemas"]["McpServerInstallRequest"];
export type McpServerListResponse = components["schemas"]["McpServerListResponse"];
export type McpServerStatus = components["schemas"]["McpServerStatus"];
export type ModelSummary = components["schemas"]["ModelSummary"];
export type PendingTimelineRequestSummary = components["schemas"]["PendingTimelineRequestSummary"];
export type Project = components["schemas"]["Project"];
export type PreviewCreateRequest = components["schemas"]["PreviewCreateRequest"];
export type PreviewListResponse = components["schemas"]["PreviewListResponse"];
export type PreviewRouteCreateRequest = components["schemas"]["PreviewRouteCreateRequest"];
export type PreviewRouteUpdateRequest = components["schemas"]["PreviewRouteUpdateRequest"];
export type PreviewServiceCreateRequest = components["schemas"]["PreviewServiceCreateRequest"];
export type PreviewServiceUpdateRequest = components["schemas"]["PreviewServiceUpdateRequest"];
export type PreviewSubsystemStatus = components["schemas"]["PreviewSubsystemStatus"];
export type PreviewUpdateRequest = components["schemas"]["PreviewUpdateRequest"];
export type ProjectPreview = components["schemas"]["ProjectPreviewDto"];
export type ProjectPreviewRoute = components["schemas"]["ProjectPreviewRouteDto"];
export type ProjectPreviewService = components["schemas"]["ProjectPreviewServiceDto"];
export type QueuedInput = components["schemas"]["QueuedInput"];
export type QueuedInputCreateRequest = components["schemas"]["QueuedInputCreateRequest"];
export type RateLimitSnapshot = components["schemas"]["RateLimitSnapshot"];
export type RateLimitWindow = components["schemas"]["RateLimitWindow"];
export type RateLimitsResponse = components["schemas"]["RateLimitsResponse"];
export type SkillMetadata = components["schemas"]["SkillMetadata"];
export type SkillsCatalogResponse = components["schemas"]["SkillsCatalogResponse"];
export type ThreadRead = components["schemas"]["ThreadRead"];
export type ThreadReadStateUpdate = components["schemas"]["ThreadReadStateUpdate"];
export type ThreadNotificationSettingsResponse = components["schemas"]["ThreadNotificationSettingsResponse"];
export type ThreadAttachResponse = components["schemas"]["ThreadAttachResponse"];
export type ThreadListResponse = components["schemas"]["ThreadListResponse"];
export type SidebarThreadSummary = components["schemas"]["SidebarThreadSummary"];
export type SidebarThreadsResponse = components["schemas"]["SidebarThreadsResponse"];
export type ThreadViewResponse = components["schemas"]["ThreadViewResponse"];
export type ThreadViewThreadSummary = components["schemas"]["ThreadViewThreadSummary"];
export type RenameThreadRequest = components["schemas"]["RenameThreadRequest"];
export type ThreadSubagentListResponse = components["schemas"]["ThreadSubagentListResponse"];
export type ThreadSubagentSummary = components["schemas"]["ThreadSubagentSummary"];
export type TextElement = components["schemas"]["TextElement"];
export type ThreadCommandResponse = components["schemas"]["ThreadCommandResponse"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadTimelineFileChangeEntry = components["schemas"]["ThreadTimelineFileChangeEntry"];
export type ThreadTimelineRow = components["schemas"]["ThreadTimelineRow"];
export type ThreadTimelineSnapshot = components["schemas"]["ThreadTimelineSnapshot"];
export type ThreadTimelineSnapshotItem = components["schemas"]["ThreadTimelineSnapshotItem"];
export type ThreadTimelineWorkDetailRow = components["schemas"]["ThreadTimelineWorkDetailRow"];
export type ThreadTimelineWorkSummary = components["schemas"]["ThreadTimelineWorkSummary"];
export type ThreadTimelineWindowPage = components["schemas"]["ThreadTimelineWindowPage"];
export type ThreadInputResponse = components["schemas"]["ThreadInputResponse"];
export type ThreadInterruptCurrentResponse = components["schemas"]["ThreadInterruptCurrentResponse"];
export type TimelineSkillMention = components["schemas"]["TimelineSkillMention"];
export type TimelineItemDeltaPayload = components["schemas"]["TimelineItemDeltaPayload"];
export type TimelineItemUpsertPayload = components["schemas"]["TimelineItemUpsertPayload"];
export type TimelineLiveState = components["schemas"]["ThreadLiveState"];
export type ThreadViewPatch = components["schemas"]["ThreadViewPatch"];
export type TimelineThreadMetadataPayload = components["schemas"]["TimelineThreadMetadataPayload"];
export type TimelineThreadStatusPayload = components["schemas"]["TimelineThreadStatusPayload"];
export type TimelineTurnUpsertPayload = components["schemas"]["TimelineTurnUpsertPayload"];
export type TimelineUpdateSource = components["schemas"]["TimelineUpdateSource"];
export type UserInput = components["schemas"]["UserInput"];
export type ImageUpload = components["schemas"]["ImageUpload"];
export type CreateThreadOptions = Omit<components["schemas"]["CreateThreadRequest"], "payload" | "projectId">;
export type TurnStartOptions = Omit<components["schemas"]["TurnStartRequest"], "input">;
export type NotificationStatusResponse = components["schemas"]["NotificationStatusResponse"];
export type PushSubscriptionDeleteResponse = components["schemas"]["PushSubscriptionDeleteResponse"];
export type PushSubscriptionUpsertResponse = components["schemas"]["PushSubscriptionUpsertResponse"];

type GatewayErrorBody = {
  message?: unknown;
};

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

export async function getCapabilities(): Promise<Capabilities> {
  return unwrap(api.GET("/v1/capabilities"));
}

export async function listProjects(): Promise<Project[]> {
  const response = await unwrap(api.GET("/v1/projects"));
  return response.projects;
}

export async function createProject(input: { createDirectory?: boolean; cwd: string }): Promise<Project> {
  return unwrap(api.POST("/v1/projects", { body: input }));
}

export async function getProjectPreviewSettings(projectId: string): Promise<PreviewListResponse> {
  return unwrap(api.GET("/v1/projects/{projectId}/previews", { params: { path: { projectId } } }));
}

export async function createProjectPreviewService(
  projectId: string,
  request: PreviewServiceCreateRequest,
): Promise<ProjectPreviewService> {
  const response = await unwrap(
    api.POST("/v1/projects/{projectId}/preview-services", {
      params: { path: { projectId } },
      body: request,
    }),
  );
  return response.service;
}

export async function updateProjectPreviewService(
  projectId: string,
  serviceId: string,
  request: PreviewServiceUpdateRequest,
): Promise<ProjectPreviewService> {
  const response = await unwrap(
    api.PATCH("/v1/projects/{projectId}/preview-services/{serviceId}", {
      params: { path: { projectId, serviceId } },
      body: request,
    }),
  );
  return response.service;
}

export async function deleteProjectPreviewService(projectId: string, serviceId: string): Promise<void> {
  await unwrap(
    api.DELETE("/v1/projects/{projectId}/preview-services/{serviceId}", {
      params: { path: { projectId, serviceId } },
    }),
  );
}

export async function createProjectPreview(
  projectId: string,
  request: PreviewCreateRequest,
): Promise<ProjectPreview> {
  return unwrap(
    api.POST("/v1/projects/{projectId}/previews", {
      params: { path: { projectId } },
      body: request,
    }),
  );
}

export async function updateProjectPreview(
  projectId: string,
  previewId: string,
  request: PreviewUpdateRequest,
): Promise<ProjectPreview> {
  return unwrap(
    api.PATCH("/v1/projects/{projectId}/previews/{previewId}", {
      params: { path: { projectId, previewId } },
      body: request,
    }),
  );
}

export async function deleteProjectPreview(projectId: string, previewId: string): Promise<void> {
  await unwrap(
    api.DELETE("/v1/projects/{projectId}/previews/{previewId}", {
      params: { path: { projectId, previewId } },
    }),
  );
}

export async function createProjectPreviewRoute(
  projectId: string,
  previewId: string,
  request: PreviewRouteCreateRequest,
): Promise<ProjectPreviewRoute> {
  const response = await unwrap(
    api.POST("/v1/projects/{projectId}/previews/{previewId}/routes", {
      params: { path: { projectId, previewId } },
      body: request,
    }),
  );
  return response.route;
}

export async function updateProjectPreviewRoute(
  projectId: string,
  previewId: string,
  routeId: string,
  request: PreviewRouteUpdateRequest,
): Promise<ProjectPreviewRoute> {
  const response = await unwrap(
    api.PATCH("/v1/projects/{projectId}/previews/{previewId}/routes/{routeId}", {
      params: { path: { projectId, previewId, routeId } },
      body: request,
    }),
  );
  return response.route;
}

export async function deleteProjectPreviewRoute(
  projectId: string,
  previewId: string,
  routeId: string,
): Promise<void> {
  await unwrap(
    api.DELETE("/v1/projects/{projectId}/previews/{previewId}/routes/{routeId}", {
      params: { path: { projectId, previewId, routeId } },
    }),
  );
}

export async function reloadProjectPreviews(): Promise<PreviewSubsystemStatus> {
  return unwrap(api.POST("/v1/project-previews/reload"));
}

export async function listThreadsPage(
  projectId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ThreadListResponse> {
  return unwrap(
    api.GET("/v1/threads", {
      params: { query: { projectId, cursor: options.cursor ?? undefined, limit: options.limit ?? 100 } },
    }),
  );
}

export async function listThreads(projectId: string): Promise<ThreadSummary[]> {
  const response = await listThreadsPage(projectId);
  return response.threads;
}

export async function getSidebarThreads(): Promise<SidebarThreadsResponse> {
  return unwrap(api.GET("/v1/sidebar/threads"));
}

export async function listChatThreadsPage(
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ThreadListResponse> {
  return unwrap(
    api.GET("/v1/chats/threads", {
      params: { query: { cursor: options.cursor ?? undefined, limit: options.limit ?? undefined } },
    }),
  );
}

export async function listChatThreads(): Promise<ThreadSummary[]> {
  const response = await listChatThreadsPage();
  return response.threads;
}

export async function listPinnedThreads(): Promise<ThreadSummary[]> {
  const response = await unwrap(api.GET("/v1/threads/pinned"));
  return response.threads;
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

export async function resumeThread(threadId: string): Promise<ThreadCommandResponse> {
  return unwrap(
    api.POST("/v1/threads/{threadId}/resume", { params: { path: { threadId } }, body: {} }),
  );
}

export async function attachThread(threadId: string): Promise<ThreadAttachResponse> {
  return unwrap(api.POST("/v1/threads/{threadId}/attach", { params: { path: { threadId } } }));
}

export async function forkThread(threadId: string): Promise<ThreadSummary> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/fork", { params: { path: { threadId } }, body: {} }),
  );
  return response.thread;
}

export async function getThreadDetail(threadId: string): Promise<ThreadViewResponse> {
  return unwrap(api.GET("/v1/threads/{threadId}", { params: { path: { threadId } } }));
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

export async function listThreadSubagents(threadId: string): Promise<ThreadSubagentSummary[]> {
  const response = await unwrap(
    api.GET("/v1/threads/{threadId}/subagents", { params: { path: { threadId } } }),
  );
  return response.subagents;
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

export async function pinThread(threadId: string): Promise<string | null> {
  const response = await unwrap(api.POST("/v1/threads/{threadId}/pin", { params: { path: { threadId } } }));
  return response.pinnedAt ?? null;
}

export async function unpinThread(threadId: string): Promise<string | null> {
  const response = await unwrap(api.DELETE("/v1/threads/{threadId}/pin", { params: { path: { threadId } } }));
  return response.pinnedAt ?? null;
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

export async function getNotificationStatus(): Promise<NotificationStatusResponse> {
  return unwrap(api.GET("/v1/notifications/status"));
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

export async function deletePushSubscription(subscriptionId: string): Promise<PushSubscriptionDeleteResponse> {
  return unwrap(
    api.DELETE("/v1/notifications/subscriptions/{subscriptionId}", {
      params: { path: { subscriptionId } },
    }),
  );
}

export async function submitThreadInput(
  threadId: string,
  input: UserInput[],
  options: TurnStartOptions = {},
): Promise<ThreadInputResponse> {
  return unwrap(
    api.POST("/v1/threads/{threadId}/input", {
      params: { path: { threadId } },
      body: { input, ...options },
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
  options: TurnStartOptions = {},
): Promise<QueuedInput> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/queued-inputs", {
      params: { path: { threadId } },
      body: { input, ...options },
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

export async function interruptTurn(threadId: string, turnId: string): Promise<void> {
  await unwrap(
    api.POST("/v1/threads/{threadId}/turns/{turnId}/interrupt", {
      params: { path: { threadId, turnId } },
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

export async function listPendingApprovals(): Promise<Approval[]> {
  const response = await unwrap(api.GET("/v1/approvals", { params: { query: { status: "pending" } } }));
  return response.approvals;
}

export async function decideApproval(approvalId: string, decision: ApprovalResponse): Promise<Approval> {
  return unwrap(
    api.POST("/v1/approvals/{approvalId}/decision", {
      params: { path: { approvalId } },
      body: { decision },
    }),
  );
}

export async function getAccount(): Promise<AccountResponse> {
  return unwrap(api.GET("/v1/account"));
}

export async function startLogin() {
  return unwrap(api.POST("/v1/account/login", { body: { codexStreamlinedLogin: true } }));
}

export async function cancelLogin(loginId: string): Promise<void> {
  await unwrap(api.POST("/v1/account/login/{loginId}/cancel", { params: { path: { loginId } } }));
}

export async function logout(): Promise<void> {
  await unwrap(api.POST("/v1/account/logout"));
}

export async function getRateLimits(): Promise<RateLimitsResponse> {
  return unwrap(api.GET("/v1/account/rate-limits"));
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

export async function listMcpServers(): Promise<McpServerListResponse> {
  return unwrap(api.GET("/v1/mcp/servers", { params: { query: { detail: "full" } } }));
}

export async function listConfiguredMcpServers(): Promise<ConfiguredMcpServerListResponse> {
  return unwrap(api.GET("/v1/mcp/configured-servers"));
}

export async function addMcpServer(request: McpServerInstallRequest): Promise<McpConfigMutationResponse> {
  return unwrap(api.POST("/v1/mcp/servers", { body: request }));
}

export async function replaceMcpServer(
  server: string,
  request: McpServerInstallRequest,
): Promise<McpConfigMutationResponse> {
  return unwrap(api.POST("/v1/mcp/servers/{server}/replace", { params: { path: { server } }, body: request }));
}

export async function setMcpServerEnabled(server: string, enabled: boolean): Promise<McpConfigMutationResponse> {
  return unwrap(
    api.PATCH("/v1/mcp/servers/{server}/enabled", {
      params: { path: { server } },
      body: { enabled },
    }),
  );
}

export async function removeMcpServer(server: string): Promise<McpConfigMutationResponse> {
  return unwrap(api.DELETE("/v1/mcp/servers/{server}", { params: { path: { server } } }));
}

export async function reloadMcpServers(): Promise<void> {
  await unwrap(api.POST("/v1/mcp/reload"));
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

export async function getComposerSettings(projectId?: string | null): Promise<ComposerSettingsResponse> {
  return unwrap(
    api.GET("/v1/composer-settings", { params: { query: { projectId: projectId ?? undefined } } }),
  );
}

export async function persistComposerSettings(input: ComposerSettingsUpdateRequest): Promise<void> {
  await unwrap(api.PATCH("/v1/composer-settings", { body: input }));
}

async function unwrap<T>(request: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data, error } = await request;
  if (error || data === undefined) {
    throw new Error(gatewayErrorMessage(error));
  }
  return data;
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
