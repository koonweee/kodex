import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, type ComponentProps, type CSSProperties, type ReactNode } from "react";

import type { AutomationsPane as AutomationsPaneComponent } from "../automations/AutomationsPane";
import { ComposerPanel } from "../composer/ComposerPanel";
import type { PreferencesModalProps } from "../PreferencesModal";
import type { ProjectPane as ProjectPaneComponent } from "../projects/ProjectPane";
import { ThreadPanel } from "../threads/ThreadPanel";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";
import { useGeneratedUiResize } from "./useGeneratedUiResize";

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
  generatedUiOpen?: boolean;
  generatedUiPane?: ReactNode;
  isSidebarResizing: boolean;
  mainPane: "thread" | "automations" | "project";
  mobilePanel: MobilePanel;
  preferencesProps: PreferencesModalProps;
  projectPaneProps: ComponentProps<typeof ProjectPaneComponent>;
  sidebarWidth: number;
  threadPanelProps: ComponentProps<typeof ThreadPanel>;
  workspaceSidebarProps: ComponentProps<typeof WorkspaceSidebar>;
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
  generatedUiOpen,
  generatedUiPane,
  isSidebarResizing,
  mainPane,
  mobilePanel,
  preferencesProps,
  projectPaneProps,
  sidebarWidth,
  threadPanelProps,
  workspaceSidebarProps,
}: KodexShellViewProps) {
  const mainLabel = mainPane === "automations" ? "Automations" : mainPane === "project" ? "Project" : "Thread";
  const {
    generatedUiMaxWidth,
    generatedUiMinWidth,
    generatedUiWidth,
    handleGeneratedUiResizeKeyDown,
    handleGeneratedUiResizePointerDown,
    isGeneratedUiResizing,
    setGeneratedUiWorkspaceElement,
  } = useGeneratedUiResize();
  const generatedUiVisible = mainPane === "thread" && generatedUiOpen && generatedUiPane;

  return (
    <AppShell
      navbar={{ width: sidebarWidth, breakpoint: "sm" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
      data-generated-ui-resizing={isGeneratedUiResizing ? "true" : undefined}
      data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
    >
      <WorkspaceSidebar {...workspaceSidebarProps} />
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
            <div
              className="kodex-thread-workspace"
              data-generated-ui={generatedUiVisible ? "open" : "closed"}
              ref={setGeneratedUiWorkspaceElement}
              style={{ "--kodex-generated-ui-width": `${generatedUiWidth}px` } as CSSProperties}
            >
              <div className="kodex-thread-chat-column">
                <ThreadPanel {...threadPanelProps} />
                <ComposerPanel {...composerPanelProps} />
              </div>
              {generatedUiVisible ? (
                <>
                  <button
                    aria-label="Resize generated UI pane"
                    aria-orientation="vertical"
                    aria-valuemax={generatedUiMaxWidth}
                    aria-valuemin={generatedUiMinWidth}
                    aria-valuenow={generatedUiWidth}
                    className="kodex-generated-ui-resize-handle"
                    onKeyDown={handleGeneratedUiResizeKeyDown}
                    onPointerDown={handleGeneratedUiResizePointerDown}
                    role="separator"
                    type="button"
                  />
                  <div className="kodex-generated-ui-surface">{generatedUiPane}</div>
                </>
              ) : null}
            </div>
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
