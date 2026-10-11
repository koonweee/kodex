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

export function isThemeWorkbenchRoute(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/__theme";
}

function currentLocationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function historyState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
}

export function pathForKodexRoute(route: KodexRoute): string {
  const executorId = route.executorId ?? currentKodexRoute().executorId ?? "local";
  if (route.view === "automations") {
    return automationsPath(executorId, { panel: route.panel });
  }
  if (route.view === "project" && route.projectId) {
    return projectPath(route.projectId, executorId, { panel: route.panel });
  }
  if (route.threadId) {
    return threadPath(route.threadId, executorId, { panel: route.panel });
  }
  return emptyPath(executorId, { panel: route.panel });
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
