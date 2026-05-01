import createClient from "openapi-fetch";

import type { components, paths } from "./generated/schema";

export type AccountResponse = components["schemas"]["AccountResponse"];
export type Approval = components["schemas"]["Approval"];
export type ApprovalResponse = Record<string, unknown>;
export type Capabilities = components["schemas"]["CapabilitiesResponse"];
export type EventEnvelope = components["schemas"]["EventEnvelope"];
export type LoginStartResponse = components["schemas"]["LoginStartResponse"];
export type ModelSummary = components["schemas"]["ModelSummary"];
export type Project = components["schemas"]["Project"];
export type RateLimitsResponse = components["schemas"]["RateLimitsResponse"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];

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

export async function getCapabilities(): Promise<Capabilities> {
  return unwrap(api.GET("/v1/capabilities"));
}

export async function listProjects(): Promise<Project[]> {
  const response = await unwrap(api.GET("/v1/projects"));
  return response.projects;
}

export async function createProject(input: { name?: string | null; cwd: string }): Promise<Project> {
  return unwrap(api.POST("/v1/projects", { body: input }));
}

export async function listThreads(projectId: string): Promise<ThreadSummary[]> {
  const response = await unwrap(
    api.GET("/v1/threads", { params: { query: { projectId, limit: 100 } } }),
  );
  return response.threads;
}

export async function createThread(projectId: string): Promise<ThreadSummary> {
  const response = await unwrap(api.POST("/v1/threads", { body: { projectId } }));
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

export async function archiveThread(threadId: string): Promise<void> {
  await unwrap(api.POST("/v1/threads/{threadId}/archive", { params: { path: { threadId } } }));
}

export async function listEvents(threadId: string): Promise<EventEnvelope[]> {
  const response = await unwrap(api.GET("/v1/events", { params: { query: { threadId } } }));
  return response.events;
}

export async function startTurn(threadId: string, text: string): Promise<void> {
  await unwrap(
    api.POST("/v1/threads/{threadId}/turns", {
      params: { path: { threadId } },
      body: { input: [{ type: "text", text }] },
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

export async function steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
  await unwrap(
    api.POST("/v1/threads/{threadId}/turns/{turnId}/steer", {
      params: { path: { threadId, turnId } },
      body: { input: [{ type: "text", text }] },
    }),
  );
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

async function unwrap<T>(request: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data, error } = await request;
  if (error || data === undefined) {
    throw new Error("Gateway request failed");
  }
  return data;
}
