import type { MobilePanel } from "./KodexShellView";

export type KodexMainPane = "thread" | "automations" | "project";

export type KodexRoute = {
  executorId?: string | null;
  panel: MobilePanel | null;
  projectId?: string | null;
  threadId: string | null;
  view?: KodexMainPane;
};

export function parseKodexLocation(location: Pick<Location, "pathname" | "search">): KodexRoute {
  const panel = panelFromSearch(location.search);
  const executorRoute = executorRouteFromPath(location.pathname);
  if (!executorRoute) {
    const legacyThreadId = threadIdFromPath(location.pathname);
    if (legacyThreadId) {
      return { executorId: null, panel, projectId: null, threadId: legacyThreadId, view: "thread" };
    }
    return { executorId: null, panel, projectId: null, threadId: null, view: "thread" };
  }
  const { executorId, nestedPath } = executorRoute;
  if (nestedPath === "/automations") {
    return { executorId, panel, projectId: null, threadId: null, view: "automations" };
  }
  const projectId = projectIdFromPath(nestedPath);
  if (projectId) {
    return { executorId, panel, projectId, threadId: null, view: "project" };
  }
  const threadId = threadIdFromPath(nestedPath);
  return { executorId, panel, projectId: null, threadId, view: "thread" };
}

export function emptyPath(executorId: string | null, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ executorId, panel: options.panel ?? null, projectId: null, threadId: null, view: "thread" });
}

export function threadPath(threadId: string, executorId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ executorId, panel: options.panel ?? null, projectId: null, threadId, view: "thread" });
}

export function automationsPath(executorId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ executorId, panel: options.panel ?? null, projectId: null, threadId: null, view: "automations" });
}

export function projectPath(projectId: string, executorId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ executorId, panel: options.panel ?? null, projectId, threadId: null, view: "project" });
}

function routePath(route: KodexRoute): string {
  const nestedPath =
    route.view === "automations"
      ? "/automations"
      : route.view === "project" && route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}`
      : route.threadId
        ? `/threads/${encodeURIComponent(route.threadId)}`
        : "";
  const path = route.executorId
    ? `/executors/${encodeURIComponent(route.executorId)}${nestedPath}`
    : "/";
  const query = new URLSearchParams();
  if (route.panel === "threads") {
    query.set("panel", "threads");
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

function executorRouteFromPath(pathname: string): { executorId: string; nestedPath: string } | null {
  const match = pathname.match(/^\/executors\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  try {
    return { executorId: decodeURIComponent(match[1]), nestedPath: match[2] ?? "" };
  } catch {
    return null;
  }
}

function panelFromSearch(search: string): MobilePanel | null {
  const panel = new URLSearchParams(search).get("panel");
  return panel === "threads" ? "threads" : null;
}

function threadIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/threads\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
