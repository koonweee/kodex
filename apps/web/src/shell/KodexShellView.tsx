import { AppShell, Stack } from "@mantine/core";
import type { ComponentProps } from "react";

import { ComposerPanel } from "../composer/ComposerPanel";
import { PreferencesModal } from "../PreferencesModal";
import { ThreadPanel } from "../threads/ThreadPanel";
import { WorkspaceSidebar } from "../threads/WorkspaceSidebar";

export type MobilePanel = "threads" | "chat";

type KodexShellViewProps = {
  composerPanelProps: ComponentProps<typeof ComposerPanel>;
  isSidebarResizing: boolean;
  mobilePanel: MobilePanel;
  preferencesProps: ComponentProps<typeof PreferencesModal>;
  sidebarWidth: number;
  threadPanelProps: ComponentProps<typeof ThreadPanel>;
  workspaceSidebarProps: ComponentProps<typeof WorkspaceSidebar>;
};

export function KodexShellView({
  composerPanelProps,
  isSidebarResizing,
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
          <ThreadPanel {...threadPanelProps} />
          <ComposerPanel {...composerPanelProps} />
        </Stack>
      </AppShell.Main>
      <PreferencesModal {...preferencesProps} />
    </AppShell>
  );
}
