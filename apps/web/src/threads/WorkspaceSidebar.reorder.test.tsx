import { AppShell, MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../api/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar project reorder", () => {
  it("emits a persisted order when a project is dragged before another project", () => {
    const onReorderProjects = vi.fn();
    render(
      <MantineProvider>
        <AppShell>
          <WorkspaceSidebar
            account={null}
            approvals={[]}
            hoveredThreadActionId={null}
            isSidebarResizing={false}
            loginState={{}}
            onArchiveThread={vi.fn()}
            onCancelLogin={vi.fn()}
            onCreateProject={vi.fn()}
            onCreateThread={vi.fn()}
            onLogin={vi.fn()}
            onLogout={vi.fn()}
            onOpenPreferences={vi.fn()}
            onProjectCwdChange={vi.fn()}
            onProjectFormOpenChange={vi.fn()}
            onProjectNameChange={vi.fn()}
            onReorderProjects={onReorderProjects}
            onSelectProject={vi.fn()}
            onSelectThread={vi.fn()}
            onShowDebugEventsChange={vi.fn()}
            onSidebarResizeKeyDown={vi.fn()}
            onSidebarResizePointerDown={vi.fn()}
            onThreadActionHoverChange={vi.fn()}
            pendingTitleThreadIds={new Set()}
            projectCwd=""
            projectFormOpen={false}
            projectName=""
            projects={[
              projectSummary("new", "New"),
              projectSummary("middle", "Middle"),
              projectSummary("old", "Old"),
            ]}
            selectedProjectId="new"
            selectedThreadId={null}
            showDebugEvents={false}
            sidebarWidth={320}
            threadsByProjectId={{}}
          />
        </AppShell>
      </MantineProvider>,
    );

    const data = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "",
      effectAllowed: "",
      getData: (type: string) => data.get(type) ?? "",
      setData: (type: string, value: string) => data.set(type, value),
    };

    fireEvent.dragStart(screen.getByRole("button", { name: /drag to reorder project: old/i }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("group", { name: "New" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "New" }), { dataTransfer });

    expect(onReorderProjects).toHaveBeenCalledWith(["old", "new", "middle"]);
  });
});

function projectSummary(id: string, name: string): Project {
  return {
    createdAt: "2026-05-01T00:00:00Z",
    cwd: `/workspace/${id}`,
    id,
    name,
    updatedAt: "2026-05-01T00:00:00Z",
  };
}
