import type { MobilePanel } from "./KodexShellView";

export type KodexMainPane = "thread" | "automations" | "project";

export type KodexRoute = {
  panel: MobilePanel | null;
  projectId?: string | null;
  threadId: string | null;
  view?: KodexMainPane;
};

export function parseKodexLocation(location: Pick<Location, "pathname" | "search">): KodexRoute {
  const panel = panelFromSearch(location.search);
  if (location.pathname === "/automations") {
    return { panel, projectId: null, threadId: null, view: "automations" };
  }
  const projectId = projectIdFromPath(location.pathname);
  if (projectId) {
    return { panel, projectId, threadId: null, view: "project" };
  }
  const threadId = threadIdFromPath(location.pathname);
  return { panel, projectId: null, threadId, view: "thread" };
}

export function emptyPath(options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, projectId: null, threadId: null, view: "thread" });
}

export function threadPath(threadId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, projectId: null, threadId, view: "thread" });
}

export function automationsPath(options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, projectId: null, threadId: null, view: "automations" });
}

export function projectPath(projectId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, projectId, threadId: null, view: "project" });
}

function routePath(route: KodexRoute): string {
  const path =
    route.view === "automations"
      ? "/automations"
      : route.view === "project" && route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}`
      : route.threadId
        ? `/threads/${encodeURIComponent(route.threadId)}`
        : "/";
  const query = new URLSearchParams();
  if (route.panel === "threads") {
    query.set("panel", "threads");
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
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
