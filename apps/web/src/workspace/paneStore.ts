import type { GeneratedUiPaneTarget, TerminalPaneTarget, ThreadPaneTarget, WorkspaceModel, WorkspacePane, WorkspacePaneState } from "./paneTypes";

export const WORKSPACE_PANE_STATE_VERSION = 1;
export const WORKSPACE_PANE_STORAGE_KEY = "kodex.workspace.panes.v1";

export type WorkspacePaneStoreAdapter = {
  load: () => WorkspacePaneState;
  save: (state: WorkspacePaneState) => void;
};

export const browserWorkspacePaneStore: WorkspacePaneStoreAdapter = {
  load: () => {
    if (typeof window === "undefined") {
      return createDefaultWorkspaceState();
    }
    return parseWorkspacePaneState(window.localStorage.getItem(WORKSPACE_PANE_STORAGE_KEY));
  },
  save: (state) => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(WORKSPACE_PANE_STORAGE_KEY, JSON.stringify(serializeWorkspacePaneState(state)));
  },
};

export function createMemoryWorkspacePaneStore(initialState?: WorkspacePaneState): WorkspacePaneStoreAdapter & {
  getState: () => WorkspacePaneState;
} {
  let state = normalizeWorkspacePaneState(initialState) ?? createDefaultWorkspaceState();
  return {
    getState: () => state,
    load: () => state,
    save: (nextState) => {
      state = normalizeWorkspacePaneState(nextState) ?? createDefaultWorkspaceState();
    },
  };
}

export function createDefaultWorkspaceState(): WorkspacePaneState {
  const pane = createDraftThreadPane();
  return {
    activePaneId: pane.id,
    dockviewLayout: null,
    panes: [pane],
    schemaVersion: WORKSPACE_PANE_STATE_VERSION,
  };
}

export function createDraftThreadPane(projectId?: string | null): WorkspacePane {
  return {
    id: createPaneId("thread"),
    kind: "thread",
    target: projectId ? { mode: "draft", projectId } : { mode: "draft" },
    title: projectId ? "New thread" : "New chat",
  };
}

export function createPaneId(kind: WorkspacePane["kind"]): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${kind}-${randomId}`;
}

export function parseWorkspacePaneState(serialized: string | null): WorkspacePaneState {
  if (!serialized) {
    return createDefaultWorkspaceState();
  }
  try {
    return normalizeWorkspacePaneState(JSON.parse(serialized)) ?? createDefaultWorkspaceState();
  } catch {
    return createDefaultWorkspaceState();
  }
}

export function serializeWorkspacePaneState(state: WorkspacePaneState): WorkspacePaneState {
  return normalizeWorkspacePaneState(state) ?? createDefaultWorkspaceState();
}

export function normalizeWorkspacePaneState(value: unknown): WorkspacePaneState | null {
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_PANE_STATE_VERSION || !Array.isArray(value.panes)) {
    return null;
  }
  const panes = value.panes.filter(isWorkspacePane);
  if (panes.length === 0) {
    return null;
  }
  const activePaneId = typeof value.activePaneId === "string" && panes.some((pane) => pane.id === value.activePaneId)
    ? value.activePaneId
    : panes[0]?.id ?? null;
  return {
    activePaneId,
    dockviewLayout: value.dockviewLayout ?? null,
    panes,
    schemaVersion: WORKSPACE_PANE_STATE_VERSION,
  };
}

export function ensureWorkspaceHasActivePane(workspace: WorkspaceModel): WorkspaceModel {
  if (workspace.panes.length === 0) {
    return createDefaultWorkspaceState();
  }
  if (workspace.activePaneId && workspace.panes.some((pane) => pane.id === workspace.activePaneId)) {
    return workspace;
  }
  return {
    ...workspace,
    activePaneId: workspace.panes[0]?.id ?? null,
  };
}

function isWorkspacePane(value: unknown): value is WorkspacePane {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
    return false;
  }
  const title = value.title;
  if (title !== undefined && title !== null && typeof title !== "string") {
    return false;
  }
  if (value.kind === "thread") {
    return isThreadPaneTarget(value.target);
  }
  if (value.kind === "generatedUi") {
    return isGeneratedUiPaneTarget(value.target);
  }
  if (value.kind === "terminal") {
    return isTerminalPaneTarget(value.target);
  }
  return false;
}

function isThreadPaneTarget(value: unknown): value is ThreadPaneTarget {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "existing") {
    return typeof value.threadId === "string";
  }
  if (value.mode === "draft") {
    return value.projectId === undefined || value.projectId === null || typeof value.projectId === "string";
  }
  return false;
}

function isGeneratedUiPaneTarget(value: unknown): value is GeneratedUiPaneTarget {
  if (!isRecord(value) || typeof value.threadId !== "string") {
    return false;
  }
  if (value.mode === "latest") {
    return true;
  }
  if (value.mode === "session") {
    return typeof value.sessionId === "string";
  }
  return false;
}

function isTerminalPaneTarget(value: unknown): value is TerminalPaneTarget {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of ["command", "cwd", "terminalId"] as const) {
    const child = value[key];
    if (child !== undefined && child !== null && typeof child !== "string") {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
