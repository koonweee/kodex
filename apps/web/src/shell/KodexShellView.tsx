import { AppShell, Button, Group, Stack, Title } from "@mantine/core";
import { lazy, Suspense, type ComponentProps } from "react";

import type { AutomationsPane as AutomationsPaneComponent } from "../automations/AutomationsPane";
import { ComposerPanel } from "../composer/ComposerPanel";
import { PreferencesModal } from "../PreferencesModal";
import { ThreadPanel } from "../threads/ThreadPanel";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";

export type MobilePanel = "threads" | "chat";

const AutomationsPane = lazy(() =>
  import("../automations/AutomationsPane").then((module) => ({ default: module.AutomationsPane })),
);

type KodexShellViewProps = {
  automationsPaneProps: ComponentProps<typeof AutomationsPaneComponent>;
  composerPanelProps: ComponentProps<typeof ComposerPanel>;
  isSidebarResizing: boolean;
  mainPane: "thread" | "automations";
  mobilePanel: MobilePanel;
  preferencesProps: ComponentProps<typeof PreferencesModal>;
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
  isSidebarResizing,
  mainPane,
  mobilePanel,
  preferencesProps,
  sidebarWidth,
  threadPanelProps,
  workspaceSidebarProps,
}: KodexShellViewProps) {
  return (
    <AppShell
      navbar={{ width: sidebarWidth, breakpoint: "sm" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
      data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
    >
      <WorkspaceSidebar {...workspaceSidebarProps} />
      <AppShell.Main aria-label="Thread" className="kodex-main">
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
          ) : (
            <>
              <ThreadPanel {...threadPanelProps} />
              <ComposerPanel {...composerPanelProps} />
            </>
          )}
        </Stack>
      </AppShell.Main>
      <PreferencesModal {...preferencesProps} />
    </AppShell>
  );
}
