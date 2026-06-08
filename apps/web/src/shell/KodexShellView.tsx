import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";

import type { AutomationsPane as AutomationsPaneComponent } from "../automations/AutomationsPane";
import type { PreferencesModalProps } from "../PreferencesModal";
import type { ProjectPane as ProjectPaneComponent } from "../projects/ProjectPane";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { NARROW_WORKSPACE_QUERY } from "../shared/layoutBreakpoints";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";
import type { ThreadSummary } from "../api/client";
import { WorkspaceSinglePaneShell } from "../workspace/WorkspaceSinglePaneShell";
import { WorkspaceShell } from "../workspace/WorkspaceShell";
import { useWorkspace } from "../workspace/WorkspaceProvider";

export type MobilePanel = "threads" | "chat";

const AutomationsPane = lazy(() =>
  import("../automations/AutomationsPane").then((module) => ({ default: module.AutomationsPane })),
);
const PreferencesModal = lazy(() =>
  import("../PreferencesModal").then((module) => ({ default: module.PreferencesModal })),
);
const ProjectPane = lazy(() =>
  import("../projects/ProjectPane").then((module) => ({ default: module.ProjectPane })),
);
const DESKTOP_COLLAPSED_SIDEBAR_WIDTH = 44;
const TOUCH_COLLAPSED_SIDEBAR_WIDTH = 52;
const DESKTOP_EXPANDED_SIDEBAR_WIDTH = 292;

type KodexShellViewProps = {
  automationsPaneProps: ComponentProps<typeof AutomationsPaneComponent>;
  isSidebarResizing: boolean;
  isDraftThreadSelected: boolean;
  mainPane: "thread" | "automations" | "project";
  mobilePanel: MobilePanel;
  preferencesProps: PreferencesModalProps;
  projectPaneProps: ComponentProps<typeof ProjectPaneComponent>;
  sidebarCollapsed: boolean;
  useSingleThreadWorkspace: boolean;
  workspaceSidebarProps: ComponentProps<typeof WorkspaceSidebar>;
  workspaceSelectedThreadPaneId: string | null;
};

function AutomationsPaneFallback() {
  return (
    <>
      <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-automations-header">
        <Title className="kodex-thread-title" order={3} size="h5">
          Automations
        </Title>
        <Button disabled loading size="xs">
          Add automation
        </Button>
      </Group>
      <div className="kodex-automations-pane" aria-busy="true" />
    </>
  );
}

export function KodexShellView({
  automationsPaneProps,
  isDraftThreadSelected,
  isSidebarResizing,
  mainPane,
  mobilePanel,
  preferencesProps,
  projectPaneProps,
  sidebarCollapsed: desktopSidebarCollapsed,
  useSingleThreadWorkspace,
  workspaceSidebarProps,
  workspaceSelectedThreadPaneId,
}: KodexShellViewProps) {
  const mainLabel = mainPane === "automations" ? "Automations" : mainPane === "project" ? "Project" : "Thread workspace";
  const isNarrowThreadWorkspace = useNarrowThreadWorkspace();
  const useTouchCollapsedSidebarWidth = useInputCapabilities().hasTouchInput;
  const sidebarCollapsed = desktopSidebarCollapsed && !isNarrowThreadWorkspace;
  const collapsedSidebarWidth = useTouchCollapsedSidebarWidth
    ? TOUCH_COLLAPSED_SIDEBAR_WIDTH
    : DESKTOP_COLLAPSED_SIDEBAR_WIDTH;
  const effectiveSidebarWidth = sidebarCollapsed ? collapsedSidebarWidth : DESKTOP_EXPANDED_SIDEBAR_WIDTH;
  const rendersSinglePaneWorkspace = mainPane === "thread" && useSingleThreadWorkspace;

  return (
    <AppShell
      navbar={{ width: effectiveSidebarWidth, breakpoint: "sm" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
      data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
    >
      <WorkspaceSidebarWithPaneActions
        {...workspaceSidebarProps}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={effectiveSidebarWidth}
        useSingleThreadMode={useSingleThreadWorkspace}
        workspaceSelectedThreadPaneId={workspaceSelectedThreadPaneId}
      />
      <AppShell.Main
        aria-label={mainLabel}
        className="kodex-main"
        data-single-pane-workspace={rendersSinglePaneWorkspace ? "true" : undefined}
      >
        <Stack
          h="calc(100dvh - var(--app-shell-padding))"
          gap="md"
          className="kodex-main-stack"
          data-draft-thread={isDraftThreadSelected ? "true" : undefined}
          data-single-pane-workspace={rendersSinglePaneWorkspace ? "true" : undefined}
        >
          {mainPane === "automations" ? (
            <Suspense fallback={<AutomationsPaneFallback />}>
              <AutomationsPane {...automationsPaneProps} />
            </Suspense>
          ) : mainPane === "project" ? (
            <Suspense fallback={null}>
              <ProjectPane {...projectPaneProps} />
            </Suspense>
          ) : useSingleThreadWorkspace ? (
            <WorkspaceSinglePaneShell />
          ) : (
            <WorkspaceShell />
          )}
        </Stack>
      </AppShell.Main>
      {preferencesProps.opened ? (
        <Suspense fallback={null}>
          <PreferencesModal {...preferencesProps} />
        </Suspense>
      ) : null}
    </AppShell>
  );
}

export function useNarrowThreadWorkspace(): boolean {
  const [matches, setMatches] = useState(() => narrowThreadWorkspaceMatches());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia(NARROW_WORKSPACE_QUERY);
    setMatches(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    mediaQuery.addEventListener?.("change", handleChange);
    mediaQuery.addListener?.(handleChange);
    return () => {
      mediaQuery.removeEventListener?.("change", handleChange);
      mediaQuery.removeListener?.(handleChange);
    };
  }, []);

  return matches;
}

function narrowThreadWorkspaceMatches(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_WORKSPACE_QUERY).matches
  );
}

type WorkspaceSidebarWithPaneActionsProps = ComponentProps<typeof WorkspaceSidebar> & {
  useSingleThreadMode: boolean;
  workspaceSelectedThreadPaneId: string | null;
};

function WorkspaceSidebarWithPaneActions({
  useSingleThreadMode,
  workspaceSelectedThreadPaneId,
  ...props
}: WorkspaceSidebarWithPaneActionsProps) {
  const { openDraftThreadPane, openTerminalPane, openThreadPane, threadActions } = useWorkspace();
  const titleLookupPropsRef = useRef(props);
  const seededRouteThreadPaneRef = useRef<string | null>(null);

  useEffect(() => {
    titleLookupPropsRef.current = props;
  }, [props.chatThreads, props.pinnedThreads, props.threadsByProjectId]);

  function openThread(threadId: string) {
    void openThreadPane(threadId, titleForThread(props, threadId)).catch((error: unknown) => {
      console.error("Failed to open workspace thread pane", error);
    });
  }

  useEffect(() => {
    if (props.selectedMainPane !== "thread") {
      return;
    }
    if (!workspaceSelectedThreadPaneId) {
      seededRouteThreadPaneRef.current = null;
      return;
    }
    if (seededRouteThreadPaneRef.current === workspaceSelectedThreadPaneId) {
      return;
    }
    seededRouteThreadPaneRef.current = workspaceSelectedThreadPaneId;
    void openThreadPane(
      workspaceSelectedThreadPaneId,
      titleForThread(titleLookupPropsRef.current, workspaceSelectedThreadPaneId),
    ).catch((error: unknown) => {
      console.error("Failed to reconcile route thread into workspace pane", error);
    });
  }, [
    openDraftThreadPane,
    openThreadPane,
    props.selectedProjectId,
    props.selectedMainPane,
    props.selectedThreadId,
    useSingleThreadMode,
    workspaceSelectedThreadPaneId,
  ]);

  return (
    <WorkspaceSidebar
      {...props}
      onArchiveThread={threadActions.onArchiveThread ?? props.onArchiveThread}
      onOpenTerminal={
        props.onOpenTerminal
          ? () => {
              void openTerminalPane().catch((error: unknown) => {
                console.error("Failed to open workspace terminal pane", error);
              });
              props.onOpenTerminal?.();
              if (useSingleThreadMode || narrowThreadWorkspaceMatches()) {
                props.onShowThread?.();
              }
            }
          : undefined
      }
      onCreateChat={() => {
        props.onCreateChat();
        void openDraftThreadPane(null).catch((error: unknown) => {
          console.error("Failed to open workspace draft chat pane", error);
        });
      }}
      onCreateThread={(projectId) => {
        props.onCreateThread(projectId);
        void openDraftThreadPane(projectId).catch((error: unknown) => {
          console.error("Failed to open workspace draft thread pane", error);
        });
      }}
      onSelectChatThread={(threadId) => {
        openThread(threadId);
        props.onSelectChatThread(threadId);
      }}
      onSelectPinnedThread={(threadId) => {
        openThread(threadId);
        props.onSelectPinnedThread(threadId);
      }}
      onSelectThread={(projectId, threadId) => {
        openThread(threadId);
        props.onSelectThread(projectId, threadId);
      }}
    />
  );
}

function titleForThread(props: ComponentProps<typeof WorkspaceSidebar>, threadId: string): string | null {
  const thread =
    findThread(props.chatThreads, threadId) ??
    findThread(props.pinnedThreads, threadId) ??
    findThread(Object.values(props.threadsByProjectId).flat(), threadId);
  return stringOrNull(thread?.name) ?? stringOrNull(thread?.preview);
}

function findThread(threads: ThreadSummary[], threadId: string): ThreadSummary | null {
  return threads.find((thread) => thread.id === threadId) ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
