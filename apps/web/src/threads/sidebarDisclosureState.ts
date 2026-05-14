export const SIDEBAR_DISCLOSURE_STORAGE_KEY = "kodex.sidebar.disclosureState";

export type SidebarDisclosureState = {
  chatsSectionCollapsed: boolean;
  collapsedProjectIds: Set<string>;
  pinnedSectionCollapsed: boolean;
  projectsSectionCollapsed: boolean;
};

const DEFAULT_SIDEBAR_DISCLOSURE_STATE: SidebarDisclosureState = {
  chatsSectionCollapsed: false,
  collapsedProjectIds: new Set(),
  pinnedSectionCollapsed: false,
  projectsSectionCollapsed: false,
};

type SidebarDisclosureStorageValue = {
  chatsSectionCollapsed?: unknown;
  collapsedProjectIds?: unknown;
  pinnedSectionCollapsed?: unknown;
  projectsSectionCollapsed?: unknown;
};

export function loadSidebarDisclosureState(storage: Storage | null = browserStorage()): SidebarDisclosureState {
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
      pinnedSectionCollapsed:
        typeof parsed.pinnedSectionCollapsed === "boolean" ? parsed.pinnedSectionCollapsed : false,
      projectsSectionCollapsed:
        typeof parsed.projectsSectionCollapsed === "boolean" ? parsed.projectsSectionCollapsed : false,
    };
  } catch {
    return cloneDefaultState();
  }
}

export function saveSidebarDisclosureState(
  state: SidebarDisclosureState,
  storage: Storage | null = browserStorage(),
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
        pinnedSectionCollapsed: state.pinnedSectionCollapsed,
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

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
