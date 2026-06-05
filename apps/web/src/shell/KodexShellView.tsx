import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, useEffect, useRef, type ComponentProps } from "react";

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

type KodexShellViewProps = {
  automationsPaneProps: ComponentProps<typeof AutomationsPaneComponent>;
  composerPanelProps: ComponentProps<typeof ComposerPanel>;
  isSidebarResizing: boolean;
  mainPane: "thread" | "automations" | "project";
  mobilePanel: MobilePanel;
  preferencesProps: PreferencesModalProps;
  projectPaneProps: ComponentProps<typeof ProjectPaneComponent>;
  sidebarWidth: number;
  threadPanelProps: ComponentProps<typeof ThreadPanel>;
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
  preferencesProps,
  projectPaneProps,
  sidebarWidth,
  threadPanelProps,
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

type WorkspaceSidebarWithPaneActionsProps = ComponentProps<typeof WorkspaceSidebar> & {
  workspaceSelectedThreadPaneId: string | null;
};

function WorkspaceSidebarWithPaneActions({
  workspaceSelectedThreadPaneId,
  ...props
}: WorkspaceSidebarWithPaneActionsProps) {
  const { openDraftThreadPane, openTerminalPane, openThreadPane, workspace } = useWorkspace();
  const titleLookupPropsRef = useRef(props);

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
      if (props.selectedThreadId === null) {
        void openDraftThreadPane(props.selectedProjectId).catch((error: unknown) => {
          console.error("Failed to reconcile route draft into workspace pane", error);
        });
      }
      return;
    }
    const activePane = workspace.activePaneId
      ? workspace.panes.find((candidate) => candidate.id === workspace.activePaneId) ?? null
      : null;
    const activeThreadId =
      activePane?.kind === "thread" && activePane.target.mode === "existing" ? activePane.target.threadId : null;
    const routeThreadPaneAlreadyOpen = workspace.panes.some(
      (candidate) =>
        candidate.kind === "thread" &&
        candidate.target.mode === "existing" &&
        candidate.target.threadId === workspaceSelectedThreadPaneId,
    );
    if (activeThreadId && activeThreadId !== workspaceSelectedThreadPaneId && !routeThreadPaneAlreadyOpen) {
      return;
    }
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
    workspace.activePaneId,
    workspace.panes,
    workspaceSelectedThreadPaneId,
  ]);

  return (
    <WorkspaceSidebar
      {...props}
      onOpenTerminal={
        props.onOpenTerminal
          ? () => {
              void openTerminalPane({ duplicate: true }).catch((error: unknown) => {
                console.error("Failed to open workspace terminal pane", error);
              });
            }
          : undefined
      }
      onCreateChat={() => {
        props.onCreateChat();
        void openDraftThreadPane(null, { duplicate: true }).catch((error: unknown) => {
          console.error("Failed to open workspace draft chat pane", error);
        });
      }}
      onCreateThread={(projectId) => {
        props.onCreateThread(projectId);
        void openDraftThreadPane(projectId, { duplicate: true }).catch((error: unknown) => {
          console.error("Failed to open workspace draft thread pane", error);
        });
      }}
      onSelectChatThread={(threadId) => {
        props.onSelectChatThread(threadId);
        openThread(threadId);
      }}
      onSelectPinnedThread={(threadId) => {
        props.onSelectPinnedThread(threadId);
        openThread(threadId);
      }}
      onSelectThread={(projectId, threadId) => {
        props.onSelectThread(projectId, threadId);
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
