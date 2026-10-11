import { API_VERSION } from "./compatibility";
import type {
  Capabilities,
  CreateProjectRequest,
  CreateTerminalSession,
  DirectoryListResponse,
  Project,
  TerminalDeleteResponse,
  TerminalSessionInfo,
  UpdateProjectRequest,
} from "./client";
import { unwrap, unwrapNoContent, type GatewayClientDependencies } from "./gatewayClientShared";

export function createGatewayResources({
  api,
  requestUrl,
  resolveRoute,
  transportFetch,
}: GatewayClientDependencies) {
  function terminalWebSocketUrl(terminalId: string): string {
    const route = `/v1/terminals/${encodeURIComponent(terminalId)}/ws?apiVersion=${encodeURIComponent(API_VERSION)}`;
    const browserOrigin = typeof window === "undefined" ? "http://127.0.0.1:8787" : window.location.origin;
    const url = new URL(resolveRoute(route), browserOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  function filePreviewUrl(threadId: string, path: string): string {
    const route = `/v1/threads/${encodeURIComponent(threadId)}/files/preview?path=${encodeURIComponent(path)}`;
    return resolveRoute(route);
  }
  function skillIconUrl(path: string): string {
    const route = `/v1/skills/icon?path=${encodeURIComponent(path)}`;
    return resolveRoute(route);
  }
  async function fetchThreadFilePreview(threadId: string, path: string): Promise<string> {
    const route = `/v1/threads/${encodeURIComponent(threadId)}/files/preview?path=${encodeURIComponent(path)}`;
    const response = await transportFetch(requestUrl(route));
    if (!response.ok) {
      throw new Error(`Unable to preview file: ${response.status}`);
    }
    return response.text();
  }
  async function getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
    return unwrap(api.GET("/v1/capabilities", { cache: "no-store", signal }));
  }
  async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
    const response = await unwrap(api.GET("/v1/terminals"));
    return response.terminals;
  }
  async function createTerminalSession(request: CreateTerminalSession = {}): Promise<TerminalSessionInfo> {
    const response = await unwrap(api.POST("/v1/terminals", { body: request }));
    return response.terminal;
  }
  async function deleteTerminalSession(terminalId: string): Promise<TerminalDeleteResponse> {
    return unwrap(api.DELETE("/v1/terminals/{terminalId}", { params: { path: { terminalId } } }));
  }
  async function listDirectories(path?: string, signal?: AbortSignal): Promise<DirectoryListResponse> {
    return unwrap(api.GET("/v1/directories", { params: { query: { path } }, signal, cache: "no-store" }));
  }
  async function listProjects(signal?: AbortSignal): Promise<Project[]> {
    const response = await unwrap(api.GET("/v1/projects", { signal, cache: "no-store" }));
    return response.projects;
  }
  async function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
    return unwrap(api.GET("/v1/projects/{projectId}", { params: { path: { projectId } }, cache: "no-store", signal }));
  }
  async function createProject(input: CreateProjectRequest): Promise<Project> {
    return unwrap(api.POST("/v1/projects", { body: input }));
  }
  async function updateProject(projectId: string, input: UpdateProjectRequest): Promise<Project> {
    return unwrap(api.PATCH("/v1/projects/{projectId}", { params: { path: { projectId } }, body: input }));
  }
  async function deleteProject(projectId: string): Promise<void> {
    await unwrapNoContent(api.DELETE("/v1/projects/{projectId}", { params: { path: { projectId } } }));
  }
  async function moveProject(projectId: string, beforeProjectId: string | null): Promise<void> {
    await unwrapNoContent(api.POST("/v1/projects/{projectId}/move", { params: { path: { projectId } }, body: { beforeProjectId } }));
  }

  return {
    terminalWebSocketUrl,
    filePreviewUrl,
    skillIconUrl,
    fetchThreadFilePreview,
    getCapabilities,
    listTerminalSessions,
    createTerminalSession,
    deleteTerminalSession,
    listDirectories,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    moveProject,
  };
}
