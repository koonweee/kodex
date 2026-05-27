import {
  automationsPath,
  emptyPath,
  parseKodexLocation,
  projectPath,
  threadPath,
  type KodexRoute,
} from "./navigation";

export function currentKodexRoute(): KodexRoute {
  return parseKodexLocation(window.location);
}

export function currentLocationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function historyState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
}

export function isMobileViewport(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
}

export function pathForKodexRoute(route: KodexRoute): string {
  if (route.view === "automations") {
    return automationsPath({ panel: route.panel });
  }
  if (route.view === "project" && route.projectId) {
    return projectPath(route.projectId, { panel: route.panel });
  }
  if (route.threadId) {
    return threadPath(route.threadId, { panel: route.panel });
  }
  return emptyPath({ panel: route.panel });
}

export function pushKodexRoute(route: KodexRoute) {
  const nextPath = pathForKodexRoute(route);
  if (currentLocationPath() === nextPath) {
    return;
  }
  window.history.pushState({ kodexRoute: true }, "", nextPath);
}

export function replaceKodexRoute(route: KodexRoute) {
  const nextPath = pathForKodexRoute(route);
  if (currentLocationPath() === nextPath) {
    return;
  }
  window.history.replaceState({ kodexRoute: true }, "", nextPath);
}
