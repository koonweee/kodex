import type { InstanceStorage } from "../api/instanceStorage";

export const SIDEBAR_DISCLOSURE_STORAGE_KEY = "kodex.sidebar.disclosureState";

export type SidebarDisclosureState = {
  chatsSectionCollapsed: boolean;
  collapsedProjectIds: Set<string>;
  pinnedCollapsed: boolean;
  projectsSectionCollapsed: boolean;
};

const DEFAULT_SIDEBAR_DISCLOSURE_STATE: SidebarDisclosureState = {
  chatsSectionCollapsed: false,
  collapsedProjectIds: new Set(),
  pinnedCollapsed: false,
  projectsSectionCollapsed: false,
};

type SidebarDisclosureStorageValue = {
  chatsSectionCollapsed?: unknown;
  collapsedProjectIds?: unknown;
  pinnedCollapsed?: unknown;
  projectsSectionCollapsed?: unknown;
};

export function loadSidebarDisclosureState(storage: InstanceStorage | null = null): SidebarDisclosureState {
  if (!storage) {
    return cloneDefaultState();
  }

  try {
    const value = storage.getItem(SIDEBAR_DISCLOSURE_STORAGE_KEY);
    if (!value) {
      return cloneDefaultState();
    }
    const parsed = JSON.parse(value) as SidebarDisclosureStorageValue;
    if (!parsed || typeof parsed !== "object") {
      return cloneDefaultState();
    }

    return {
      chatsSectionCollapsed:
        typeof parsed.chatsSectionCollapsed === "boolean" ? parsed.chatsSectionCollapsed : false,
      collapsedProjectIds: Array.isArray(parsed.collapsedProjectIds)
        ? new Set(parsed.collapsedProjectIds.filter((item): item is string => typeof item === "string" && item.length > 0))
        : new Set(),
      pinnedCollapsed: parsed.pinnedCollapsed === true,
      projectsSectionCollapsed:
        typeof parsed.projectsSectionCollapsed === "boolean" ? parsed.projectsSectionCollapsed : false,
    };
  } catch {
    return cloneDefaultState();
  }
}

export function saveSidebarDisclosureState(
  state: SidebarDisclosureState,
  storage: InstanceStorage | null = null,
) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      SIDEBAR_DISCLOSURE_STORAGE_KEY,
      JSON.stringify({
        chatsSectionCollapsed: state.chatsSectionCollapsed,
        collapsedProjectIds: Array.from(state.collapsedProjectIds),
        pinnedCollapsed: state.pinnedCollapsed,
        projectsSectionCollapsed: state.projectsSectionCollapsed,
      }),
    );
  } catch {
    // Keep sidebar disclosure usable when browser storage is unavailable.
  }
}

function cloneDefaultState(): SidebarDisclosureState {
  return {
    ...DEFAULT_SIDEBAR_DISCLOSURE_STATE,
    collapsedProjectIds: new Set(DEFAULT_SIDEBAR_DISCLOSURE_STATE.collapsedProjectIds),
  };
}
