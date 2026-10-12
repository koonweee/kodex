import type { components } from "./generated/schema";
import type {
  AccountResponse,
  Approval,
  ApprovalListResponse,
  ApprovalResponse,
  Automation,
  AutomationCreateRequest,
  AutomationRun,
  AutomationUpdateRequest,
  ComposerSettingsResponse,
  ComposerSettingsUpdateRequest,
  ComposerSettingsUpdateResponse,
  ConfiguredMcpServerListResponse,
  ImageUpload,
  McpConfigMutationResponse,
  McpOAuthLoginResponse,
  McpReloadResponse,
  McpResourceReadResponse,
  McpServerInstallRequest,
  McpServerListResponse,
  McpServerUpdateRequest,
  ModelSummary,
  NativeConfigWriteTarget,
  PermissionProfileSummary,
  RateLimitsResponse,
  SkillsCatalogResponse,
  ThreadInterruptCurrentResponse,
  TimelineFileAttachment,
} from "./client";
import { responseErrorMessage, unwrap, type GatewayClientDependencies } from "./gatewayClientShared";

export function createGatewayFeatures({
  api,
  requestUrl,
  transportFetch,
}: GatewayClientDependencies) {
  async function listAutomations(threadId?: string, signal?: AbortSignal): Promise<Automation[]> {
    const response = await unwrap(
      api.GET("/v1/automations", {
        params: threadId ? { query: { threadId } } : undefined,
        signal,
      }),
    );
    return response.automations;
  }
  async function listAutomationRuns(automationId: string, signal?: AbortSignal): Promise<AutomationRun[]> {
    const result = await unwrap(api.GET("/v1/automations/{automationId}/runs", {
      params: { path: { automationId } }, signal, cache: "no-store",
    }));
    return result.runs;
  }
  async function createAutomation(request: AutomationCreateRequest): Promise<Automation> {
    const response = await unwrap(api.POST("/v1/automations", { body: request }));
    return response.automation;
  }
  async function updateAutomation(
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
  async function pauseAutomation(automationId: string): Promise<Automation> {
    const response = await unwrap(
      api.POST("/v1/automations/{automationId}/pause", {
        params: { path: { automationId } },
      }),
    );
    return response.automation;
  }
  async function resumeAutomation(automationId: string): Promise<Automation> {
    const response = await unwrap(
      api.POST("/v1/automations/{automationId}/resume", {
        params: { path: { automationId } },
      }),
    );
    return response.automation;
  }
  async function deleteAutomation(automationId: string): Promise<void> {
    await unwrap(
      api.DELETE("/v1/automations/{automationId}", {
        params: { path: { automationId } },
      }),
    );
  }
  async function interruptCurrentTurn(threadId: string): Promise<ThreadInterruptCurrentResponse> {
    return unwrap(api.POST("/v1/threads/{threadId}/interrupt-current", { params: { path: { threadId } } }));
  }
  async function uploadImages(files: File[]): Promise<ImageUpload[]> {
    const formData = new FormData();
    for (const file of files) {
      formData.append("images", file);
    }
    const response = await transportFetch(requestUrl("/v1/uploads/images"), {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const body = (await response.json()) as components["schemas"]["ImageUploadResponse"];
    return body.images;
  }
  async function uploadFiles(threadId: string, files: File[]): Promise<TimelineFileAttachment[]> {
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    const response = await transportFetch(requestUrl(`/v1/threads/${encodeURIComponent(threadId)}/uploads/files`), {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const body = (await response.json()) as components["schemas"]["FileUploadResponse"];
    return body.files;
  }
  async function listPendingApprovals(signal?: AbortSignal): Promise<ApprovalListResponse> {
    return unwrap(api.GET("/v1/approvals", { signal, cache: "no-store" }));
  }
  async function decideApproval(approvalId: string, decision: ApprovalResponse): Promise<Approval> {
    return unwrap(
      api.POST("/v1/approvals/{approvalId}/decision", {
        params: { path: { approvalId } },
        body: { decision },
      }),
    );
  }
  async function getAccount(signal?: AbortSignal): Promise<AccountResponse> {
    return unwrap(api.GET("/v1/account", { signal, cache: "no-store" }));
  }
  async function startLogin() {
    return unwrap(api.POST("/v1/account/login"));
  }
  async function cancelLogin(loginId: string): Promise<void> {
    await unwrap(api.POST("/v1/account/login/{loginId}/cancel", { params: { path: { loginId } } }));
  }
  async function logout(): Promise<void> {
    await unwrap(api.POST("/v1/account/logout"));
  }
  async function getRateLimits(signal?: AbortSignal): Promise<RateLimitsResponse> {
    return unwrap(api.GET("/v1/account/rate-limits", { signal, cache: "no-store" }));
  }
  async function consumeRateLimitResetCredit(body: components["schemas"]["ConsumeRateLimitResetCreditRequest"]) {
    return unwrap(api.POST("/v1/account/rate-limit-reset-credits/consume", { body }));
  }
  async function listModels(): Promise<ModelSummary[]> {
    const response = await unwrap(api.GET("/v1/models", { params: { query: { includeHidden: false } } }));
    return response.models.filter((model) => !model.hidden);
  }
  async function listMcpServers(signal?: AbortSignal): Promise<McpServerListResponse> {
    return unwrap(api.GET("/v1/mcp/servers", { signal, cache: "no-store", params: { query: { detail: "full" } } }));
  }
  async function listConfiguredMcpServers(signal?: AbortSignal): Promise<ConfiguredMcpServerListResponse> {
    return unwrap(api.GET("/v1/mcp/configured-servers", { signal, cache: "no-store" }));
  }
  async function addMcpServer(request: McpServerInstallRequest): Promise<McpConfigMutationResponse> {
    return unwrap(api.POST("/v1/mcp/servers", { body: request }));
  }
  async function updateMcpServer(
    server: string,
    request: McpServerUpdateRequest,
  ): Promise<McpConfigMutationResponse> {
    return unwrap(api.PATCH("/v1/mcp/servers/{server}", { params: { path: { server } }, body: request }));
  }
  async function setMcpServerEnabled(server: string, enabled: boolean, writeTarget: NativeConfigWriteTarget): Promise<McpConfigMutationResponse> {
    return unwrap(
      api.PATCH("/v1/mcp/servers/{server}/enabled", {
        params: { path: { server } },
        body: { enabled, writeTarget },
      }),
    );
  }
  async function removeMcpServer(server: string, writeTarget: NativeConfigWriteTarget): Promise<McpConfigMutationResponse> {
    return unwrap(api.DELETE("/v1/mcp/servers/{server}", { params: { path: { server } }, body: { writeTarget } }));
  }
  async function reloadMcpServers(): Promise<McpReloadResponse> {
    return unwrap(api.POST("/v1/mcp/reload"));
  }
  async function startMcpOAuthLogin(server: string): Promise<McpOAuthLoginResponse> {
    return unwrap(
      api.POST("/v1/mcp/servers/{server}/oauth-login", {
        params: { path: { server } },
        body: {},
      }),
    );
  }
  async function readMcpResource(server: string, uri: string): Promise<McpResourceReadResponse> {
    return unwrap(
      api.GET("/v1/mcp/servers/{server}/resources/read", {
        params: { path: { server }, query: { uri } },
      }),
    );
  }
  async function listSkills(cwd?: string | null, forceReload = false): Promise<SkillsCatalogResponse> {
    return unwrap(
      api.GET("/v1/skills", {
        params: { query: { cwd: cwd ?? undefined, forceReload } },
      }),
    );
  }
  async function listPermissionProfiles(cwd?: string | null, signal?: AbortSignal): Promise<PermissionProfileSummary[]> {
    const response = await unwrap(
      api.GET("/v1/permission-profiles", {
        signal, cache: "no-store",
        params: { query: { cwd: cwd ?? undefined } },
      }),
    );
    return response.profiles;
  }
  async function getComposerSettings(projectId?: string | null, cwd?: string | null, signal?: AbortSignal): Promise<ComposerSettingsResponse> {
    return unwrap(
      api.GET("/v1/composer-settings", { signal, cache: "no-store", params: { query: { projectId: projectId ?? undefined, cwd: cwd ?? undefined } } }),
    );
  }
  async function persistComposerSettings(input: ComposerSettingsUpdateRequest): Promise<ComposerSettingsUpdateResponse> {
    return unwrap(api.PATCH("/v1/composer-settings", { body: input }));
  }

  return {
    listAutomations,
    listAutomationRuns,
    createAutomation,
    updateAutomation,
    pauseAutomation,
    resumeAutomation,
    deleteAutomation,
    interruptCurrentTurn,
    uploadImages,
    uploadFiles,
    listPendingApprovals,
    decideApproval,
    getAccount,
    startLogin,
    cancelLogin,
    logout,
    getRateLimits,
    consumeRateLimitResetCredit,
    listModels,
    listMcpServers,
    listConfiguredMcpServers,
    addMcpServer,
    updateMcpServer,
    setMcpServerEnabled,
    removeMcpServer,
    reloadMcpServers,
    startMcpOAuthLogin,
    readMcpResource,
    listSkills,
    listPermissionProfiles,
    getComposerSettings,
    persistComposerSettings,
  };
}
