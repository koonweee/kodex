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
export type ModelSummary = components["schemas"]["ModelSummary"];
export type Project = components["schemas"]["Project"];
export type QueuedInput = components["schemas"]["QueuedInput"];
export type QueuedInputCreateRequest = components["schemas"]["QueuedInputCreateRequest"];
export type RateLimitSnapshot = components["schemas"]["RateLimitSnapshot"];
export type RateLimitWindow = components["schemas"]["RateLimitWindow"];
export type RateLimitsResponse = components["schemas"]["RateLimitsResponse"];
export type SkillMetadata = components["schemas"]["SkillMetadata"];
export type SkillsCatalogResponse = components["schemas"]["SkillsCatalogResponse"];
export type ThreadRead = components["schemas"]["ThreadRead"];
export type ThreadDetailResponse = components["schemas"]["ThreadDetailResponse"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type TimelineItemDeltaPayload = components["schemas"]["TimelineItemDeltaPayload"];
export type TimelineItemUpsertPayload = components["schemas"]["TimelineItemUpsertPayload"];
export type TimelineLiveState = components["schemas"]["ThreadLiveState"];
export type TimelineThreadMetadataPayload = components["schemas"]["TimelineThreadMetadataPayload"];
export type TimelineThreadStatusPayload = components["schemas"]["TimelineThreadStatusPayload"];
export type TimelineTurnUpsertPayload = components["schemas"]["TimelineTurnUpsertPayload"];
export type TimelineUpdateSource = components["schemas"]["TimelineUpdateSource"];
export type UserInput = components["schemas"]["UserInput"];
export type ImageUpload = components["schemas"]["ImageUpload"];
export type CreateThreadOptions = Omit<components["schemas"]["CreateThreadRequest"], "payload" | "projectId">;
export type TurnStartOptions = Omit<components["schemas"]["TurnStartRequest"], "input">;

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

export async function listThreads(projectId: string): Promise<ThreadSummary[]> {
  const response = await unwrap(
    api.GET("/v1/threads", { params: { query: { projectId, limit: 100 } } }),
  );
  return response.threads;
}

export async function listChatThreads(): Promise<ThreadSummary[]> {
  const response = await unwrap(api.GET("/v1/chats/threads"));
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

export async function resumeThread(threadId: string): Promise<ThreadSummary> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/resume", { params: { path: { threadId } }, body: {} }),
  );
  return response.thread;
}

export async function forkThread(threadId: string): Promise<ThreadSummary> {
  const response = await unwrap(
    api.POST("/v1/threads/{threadId}/fork", { params: { path: { threadId } }, body: {} }),
  );
  return response.thread;
}

export async function getThreadDetail(threadId: string): Promise<ThreadDetailResponse> {
  return unwrap(api.GET("/v1/threads/{threadId}", { params: { path: { threadId } } }));
}

export async function archiveThread(threadId: string): Promise<void> {
  await unwrap(api.POST("/v1/threads/{threadId}/archive", { params: { path: { threadId } } }));
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

export async function startTurn(threadId: string, input: UserInput[], options: TurnStartOptions = {}): Promise<void> {
  await unwrap(
    api.POST("/v1/threads/{threadId}/turns", {
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

export async function steerTurn(threadId: string, turnId: string, input: UserInput[]): Promise<void> {
  await unwrap(
    api.POST("/v1/threads/{threadId}/turns/{turnId}/steer", {
      params: { path: { threadId, turnId } },
      body: { input },
    }),
  );
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
