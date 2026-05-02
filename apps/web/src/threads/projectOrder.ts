import type { Project } from "../api/client";

export const SIDEBAR_PROJECT_ORDER_STORAGE_KEY = "kodex.sidebar.projectOrder";

export function loadSidebarProjectOrder(storage: Storage | null = browserStorage()): string[] | null {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(SIDEBAR_PROJECT_ORDER_STORAGE_KEY);
    if (!value) {
      return null;
    }
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const order = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return order.length > 0 ? order : null;
  } catch {
    return null;
  }
}

export function saveSidebarProjectOrder(orderIds: string[], storage: Storage | null = browserStorage()) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SIDEBAR_PROJECT_ORDER_STORAGE_KEY, JSON.stringify(orderIds));
  } catch {
    // Ignore storage failures so dragging remains usable in restricted browser contexts.
  }
}

export function applySidebarProjectOrder(projects: Project[], orderIds: string[] | null): Project[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  if (!orderIds) {
    return [...projects].sort(compareProjectsByCreatedDesc);
  }

  const orderedIds = new Set(orderIds);
  const newProjects = projects.filter((project) => !orderedIds.has(project.id)).sort(compareProjectsByCreatedDesc);
  const orderedProjects = orderIds
    .map((projectId) => projectsById.get(projectId))
    .filter((project): project is Project => project !== undefined);
  const appendedProjects = projects
    .filter((project) => !orderedIds.has(project.id) && !newProjects.includes(project))
    .sort(compareProjectsByCreatedDesc);

  return [...newProjects, ...orderedProjects, ...appendedProjects];
}

export function moveProjectInSidebarOrder(orderIds: string[], sourceProjectId: string, targetProjectId: string): string[] {
  return moveProjectInSidebarOrderAt(orderIds, sourceProjectId, targetProjectId, "before");
}

export function moveProjectInSidebarOrderAt(
  orderIds: string[],
  sourceProjectId: string,
  targetProjectId: string,
  placement: "before" | "after",
): string[] {
  if (sourceProjectId === targetProjectId) {
    return orderIds;
  }

  const next = orderIds.filter((projectId) => projectId !== sourceProjectId);
  const targetIndex = next.indexOf(targetProjectId);
  if (targetIndex === -1) {
    return orderIds;
  }
  next.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceProjectId);
  return next;
}

function compareProjectsByCreatedDesc(left: Project, right: Project): number {
  return (
    timestamp(right.createdAt) - timestamp(left.createdAt) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
