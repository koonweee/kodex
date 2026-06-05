import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import type { AutomationsPane as AutomationsPaneComponent } from "../automations/AutomationsPane";
import { ComposerPanel } from "../composer/ComposerPanel";
import type { PreferencesModalProps } from "../PreferencesModal";
import type { ProjectPane as ProjectPaneComponent } from "../projects/ProjectPane";
import { ThreadPanel } from "../threads/ThreadPanel";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";
import type { ThreadSummary } from "../api/client";
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
const NARROW_THREAD_WORKSPACE_QUERY = "(max-width: 900px)";

type KodexShellViewProps = {
  automationsPaneProps: ComponentProps<typeof AutomationsPaneComponent>;
  composerPanelProps: ComponentProps<typeof ComposerPanel>;
  isSidebarResizing: boolean;
  mainPane: "thread" | "automations" | "project";
  mobilePanel: MobilePanel;
  narrowAppSurfacePane?: ReactNode;
  preferencesProps: PreferencesModalProps;
  projectPaneProps: ComponentProps<typeof ProjectPaneComponent>;
  sidebarWidth: number;
  threadPanelProps: ComponentProps<typeof ThreadPanel>;
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
  composerPanelProps,
  isSidebarResizing,
  mainPane,
  mobilePanel,
  narrowAppSurfacePane,
  preferencesProps,
  projectPaneProps,
  sidebarWidth,
  threadPanelProps,
  useSingleThreadWorkspace,
  workspaceSidebarProps,
  workspaceSelectedThreadPaneId,
}: KodexShellViewProps) {
  const mainLabel = mainPane === "automations" ? "Automations" : mainPane === "project" ? "Project" : "Thread workspace";

  return (
    <AppShell
      navbar={{ width: sidebarWidth, breakpoint: "sm" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
      data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
    >
      <WorkspaceSidebarWithPaneActions
        {...workspaceSidebarProps}
        useSingleThreadMode={useSingleThreadWorkspace}
        workspaceSelectedThreadPaneId={workspaceSelectedThreadPaneId}
      />
      <AppShell.Main aria-label={mainLabel} className="kodex-main">
        <Stack
          h="calc(100dvh - var(--app-shell-padding))"
          gap="md"
          className="kodex-main-stack"
          data-draft-thread={threadPanelProps.isDraftThreadSelected ? "true" : undefined}
        >
          {mainPane === "automations" ? (
            <Suspense fallback={<AutomationsPaneFallback />}>
              <AutomationsPane {...automationsPaneProps} />
            </Suspense>
          ) : mainPane === "project" ? (
            <Suspense fallback={null}>
              <ProjectPane {...projectPaneProps} />
            </Suspense>
          ) : useSingleThreadWorkspace && narrowAppSurfacePane ? (
            narrowAppSurfacePane
          ) : useSingleThreadWorkspace ? (
            <>
              <ThreadPanel {...threadPanelProps} />
              <ComposerPanel {...composerPanelProps} />
            </>
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
    const mediaQuery = window.matchMedia(NARROW_THREAD_WORKSPACE_QUERY);
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
    window.matchMedia(NARROW_THREAD_WORKSPACE_QUERY).matches
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
  const { openDraftThreadPane, openTerminalPane, openThreadPane } = useWorkspace();
  const titleLookupPropsRef = useRef(props);
  const seededRouteThreadPaneRef = useRef<string | null>(null);

  useEffect(() => {
    titleLookupPropsRef.current = props;
  }, [props.chatThreads, props.pinnedThreads, props.threadsByProjectId]);

  function openThread(threadId: string) {
    if (useSingleThreadMode) {
      return;
    }
    void openThreadPane(threadId, titleForThread(props, threadId), { duplicate: true }).catch((error: unknown) => {
      console.error("Failed to open workspace thread pane", error);
    });
  }

  useEffect(() => {
    if (props.selectedMainPane !== "thread") {
      return;
    }
    if (useSingleThreadMode) {
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
      onOpenTerminal={
        props.onOpenTerminal
          ? () => {
              if (useSingleThreadMode) {
                props.onOpenTerminal?.();
                return;
              }
              void openTerminalPane({ duplicate: true }).catch((error: unknown) => {
                console.error("Failed to open workspace terminal pane", error);
              });
            }
          : undefined
      }
      onCreateChat={() => {
        props.onCreateChat();
        if (useSingleThreadMode) {
          return;
        }
        void openDraftThreadPane(null, { duplicate: true }).catch((error: unknown) => {
          console.error("Failed to open workspace draft chat pane", error);
        });
      }}
      onCreateThread={(projectId) => {
        props.onCreateThread(projectId);
        if (useSingleThreadMode) {
          return;
        }
        void openDraftThreadPane(projectId, { duplicate: true }).catch((error: unknown) => {
          console.error("Failed to open workspace draft thread pane", error);
        });
      }}
      onSelectChatThread={(threadId) => {
        if (useSingleThreadMode) {
          props.onSelectChatThread(threadId);
          return;
        }
        openThread(threadId);
      }}
      onSelectPinnedThread={(threadId) => {
        if (useSingleThreadMode) {
          props.onSelectPinnedThread(threadId);
          return;
        }
        openThread(threadId);
      }}
      onSelectThread={(projectId, threadId) => {
        if (useSingleThreadMode) {
          props.onSelectThread(projectId, threadId);
          return;
        }
        openThread(threadId);
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
