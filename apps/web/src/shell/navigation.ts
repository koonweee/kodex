import type { MobilePanel } from "./KodexShellView";

export type KodexMainPane = "thread" | "automations";

export type KodexRoute = {
  panel: MobilePanel | null;
  threadId: string | null;
  view?: KodexMainPane;
};

export function parseKodexLocation(location: Pick<Location, "pathname" | "search">): KodexRoute {
  const panel = panelFromSearch(location.search);
  if (location.pathname === "/automations") {
    return { panel, threadId: null, view: "automations" };
  }
  const threadId = threadIdFromPath(location.pathname);
  return { panel, threadId, view: "thread" };
}

export function emptyPath(options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, threadId: null, view: "thread" });
}

export function threadPath(threadId: string, options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, threadId, view: "thread" });
}

export function automationsPath(options: { panel?: MobilePanel | null } = {}): string {
  return routePath({ panel: options.panel ?? null, threadId: null, view: "automations" });
}

export function routePath(route: KodexRoute): string {
  const path =
    route.view === "automations"
      ? "/automations"
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

export function isOwnedKodexRoute(location: Pick<Location, "pathname">): boolean {
  return location.pathname === "/" || location.pathname === "/automations" || threadIdFromPath(location.pathname) !== null;
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
