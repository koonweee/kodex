import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";

import type { AutomationsPane as AutomationsPaneComponent } from "../automations/AutomationsPane";
import type { PreferencesModalProps } from "../PreferencesModal";
import type { ProjectPane as ProjectPaneComponent } from "../projects/ProjectPane";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { readNarrowWorkspace, useNarrowWorkspace } from "../shared/layoutBreakpoints";
import { useProjectTerminal } from "../projects/useProjectTerminal";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";
import type { ThreadSummary } from "../api/client";
import type { QualifiedCatalogRef } from "../api/federatorClient";
import { ExecutorPickerDialog, type ExecutorChoice } from "../federation/ExecutorPickerDialog";
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
  executorId: string;
  executorChoices?: ExecutorChoice[];
  isSidebarResizing: boolean;
  isDraftThreadSelected: boolean;
  mainPane: "thread" | "automations" | "project";
  mobilePanel: MobilePanel;
  onActivateFederatedTarget?: (target: QualifiedCatalogRef, mode: "draft" | "thread") => void;
  onSelectFederatedProject?: (target: QualifiedCatalogRef, projectKey: string) => void;
  onExecutorUsed?: (executorId: string) => void;
  preferencesProps: PreferencesModalProps;
  preferredExecutorId?: string | null;
  projectPaneProps: ComponentProps<typeof ProjectPaneComponent>;
  sidebarCollapsed: boolean;
  useSingleThreadWorkspace: boolean;
  workspaceSidebarProps: ComponentProps<typeof WorkspaceSidebar>;
  workspaceSelectedThreadPaneId: string | null;
  resolveSidebarTarget?: (key: string) => QualifiedCatalogRef | null;
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
  executorId,
  executorChoices,
  isDraftThreadSelected,
  isSidebarResizing,
  mainPane,
  mobilePanel,
  onActivateFederatedTarget,
  onSelectFederatedProject,
  onExecutorUsed,
  preferencesProps,
  preferredExecutorId,
  projectPaneProps,
  sidebarCollapsed: desktopSidebarCollapsed,
  useSingleThreadWorkspace,
  workspaceSidebarProps,
  workspaceSelectedThreadPaneId,
  resolveSidebarTarget,
}: KodexShellViewProps) {
  const mainLabel = mainPane === "automations" ? "Automations" : mainPane === "project" ? "Project" : "Thread workspace";
  const isNarrowThreadWorkspace = useNarrowWorkspace();
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
      <div className="kodex-pwa-safe-area" aria-hidden="true" />
      <WorkspaceSidebarWithPaneActions
        {...workspaceSidebarProps}
        executorId={executorId}
        executorChoices={executorChoices}
        onActivateFederatedTarget={onActivateFederatedTarget}
        onSelectFederatedProject={onSelectFederatedProject}
        onExecutorUsed={onExecutorUsed}
        preferredExecutorId={preferredExecutorId}
        resolveSidebarTarget={resolveSidebarTarget}
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
          ) : (
            <WorkspaceShell singlePane={useSingleThreadWorkspace} />
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
  executorId: string;
  executorChoices?: ExecutorChoice[];
  onActivateFederatedTarget?: (target: QualifiedCatalogRef, mode: "draft" | "thread") => void;
  onSelectFederatedProject?: (target: QualifiedCatalogRef, projectKey: string) => void;
  onExecutorUsed?: (executorId: string) => void;
  preferredExecutorId?: string | null;
  resolveSidebarTarget?: (key: string) => QualifiedCatalogRef | null;
  useSingleThreadMode: boolean;
  workspaceSelectedThreadPaneId: string | null;
};

function WorkspaceSidebarWithPaneActions({
  executorId,
  executorChoices,
  onActivateFederatedTarget,
  onSelectFederatedProject,
  onExecutorUsed,
  preferredExecutorId,
  resolveSidebarTarget,
  useSingleThreadMode,
  workspaceSelectedThreadPaneId,
  ...props
}: WorkspaceSidebarWithPaneActionsProps) {
  const { openDraftThreadPane, openThreadPane, threadActions } = useWorkspace();
  const { openTerminal, terminalDirectoryDialog } = useProjectTerminal({
    projects: props.projects,
    resolveSidebarTarget,
    selectedMainPane: props.selectedMainPane,
    selectedProjectId: props.selectedProjectId,
    onOpened: () => {
      props.onOpenTerminal?.();
      if (useSingleThreadMode || readNarrowWorkspace()) props.onShowThread?.();
    },
  });
  const titleLookupPropsRef = useRef(props);
  const seededRouteThreadPaneRef = useRef<string | null>(null);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);

  useEffect(() => {
    titleLookupPropsRef.current = props;
  }, [props.chatThreads, props.pinnedThreads, props.threadsByProjectId]);

  function targetFor(key: string): QualifiedCatalogRef {
    return resolveSidebarTarget?.(key) ?? { executorId, nativeId: key };
  }

  function openThread(threadId: string) {
    const target = targetFor(threadId);
    void openThreadPane(target.nativeId, titleForThread(props, threadId), { executorId: target.executorId }).catch((error: unknown) => {
      console.error("Failed to open workspace thread pane", error);
    });
    return target;
  }

  function openDraftChat(targetExecutorId: string) {
    onExecutorUsed?.(targetExecutorId);
    onActivateFederatedTarget?.({ executorId: targetExecutorId, nativeId: "" }, "draft");
    if (targetExecutorId === executorId) props.onCreateChat();
    void openDraftThreadPane(null, { executorId: targetExecutorId }).catch((error: unknown) => {
      console.error("Failed to open workspace draft chat pane", error);
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
      { executorId },
    ).catch((error: unknown) => {
      console.error("Failed to reconcile route thread into workspace pane", error);
    });
  }, [
    openDraftThreadPane,
    openThreadPane,
    executorId,
    props.selectedProjectId,
    props.selectedMainPane,
    props.selectedThreadId,
    useSingleThreadMode,
    workspaceSelectedThreadPaneId,
  ]);

  return (
    <>
    <WorkspaceSidebar
      {...props}
      onArchiveThread={resolveSidebarTarget ? props.onArchiveThread : threadActions.onArchiveThread ?? props.onArchiveThread}
      onOpenTerminal={props.onOpenTerminal ? openTerminal : undefined}
      onCreateChat={() => {
        if (executorChoices && executorChoices.length !== 1) {
          setChatPickerOpen(true);
          return;
        }
        openDraftChat(executorChoices?.[0]?.id ?? executorId);
      }}
      onCreateThread={(projectId) => {
        const target = targetFor(projectId);
        onActivateFederatedTarget?.(target, "draft");
        if (target.executorId === executorId) props.onCreateThread(target.nativeId);
        void openDraftThreadPane(target.nativeId, { executorId: target.executorId }).catch((error: unknown) => {
          console.error("Failed to open workspace draft thread pane", error);
        });
      }}
      onSelectChatThread={(threadId) => {
        const target = openThread(threadId);
        onActivateFederatedTarget?.(target, "thread");
        if (target.executorId === executorId) props.onSelectChatThread(target.nativeId);
      }}
      onSelectPinnedThread={(threadId) => {
        const target = openThread(threadId);
        onActivateFederatedTarget?.(target, "thread");
        if (target.executorId === executorId) props.onSelectPinnedThread(target.nativeId);
      }}
      onSelectProjectSettings={(projectId) => {
        const target = targetFor(projectId);
        onSelectFederatedProject?.(target, projectId);
        if (target.executorId === executorId) props.onSelectProjectSettings(target.nativeId);
      }}
      onSelectThread={(projectId, threadId) => {
        const target = openThread(threadId);
        const projectTarget = targetFor(projectId);
        onActivateFederatedTarget?.(target, "thread");
        if (target.executorId === executorId) props.onSelectThread(projectTarget.nativeId, target.nativeId);
      }}
    />
    {executorChoices ? (
      <ExecutorPickerDialog
        choices={executorChoices}
        kind="chat"
        onClose={() => setChatPickerOpen(false)}
        onConfirm={(targetExecutorId) => {
          setChatPickerOpen(false);
          openDraftChat(targetExecutorId);
        }}
        opened={chatPickerOpen}
        preferredExecutorId={preferredExecutorId ?? executorId}
      />
    ) : null}
    {terminalDirectoryDialog}
    </>
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
