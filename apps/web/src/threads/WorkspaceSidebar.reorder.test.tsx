import { AppShell, MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../api/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar project reorder", () => {
  it("emits a persisted order when a project is dragged before another project", () => {
    const onReorderProjects = vi.fn();
    const { container } = render(
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
      setDragImage: vi.fn(),
      setData: (type: string, value: string) => data.set(type, value),
    };
    const oldHandle = screen.getByRole("button", { name: /drag to reorder project: old/i });
    const newProjectButton = screen.getByRole("button", { name: /new \/workspace\/new/i });
    const newProjectRow = newProjectButton.closest(".kodex-project-row");
    expect(newProjectRow).toBeInTheDocument();
    vi.spyOn(newProjectRow!, "getBoundingClientRect").mockReturnValue(rect({ top: 40, height: 20 }));

    fireEvent.dragStart(oldHandle, { dataTransfer });
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(oldHandle.closest(".kodex-project-row"), 12, 0);
    fireEvent.dragOver(screen.getByRole("group", { name: "New" }), { dataTransfer, clientY: 45 });
    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);

    fireEvent.dragOver(newProjectButton, { dataTransfer, clientY: 45 });
    expect(projectOrder(container)).toEqual(["Old", "New", "Middle"]);
    expect(onReorderProjects).not.toHaveBeenCalled();

    fireEvent.dragEnd(oldHandle, { dataTransfer });
    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onReorderProjects).not.toHaveBeenCalled();

    fireEvent.dragStart(oldHandle, { dataTransfer });
    fireEvent.dragOver(newProjectButton, { dataTransfer, clientY: 45 });
    fireEvent.drop(screen.getByRole("group", { name: "New" }), { dataTransfer });

    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onReorderProjects).toHaveBeenCalledWith(["old", "new", "middle"]);
  });
});

function projectOrder(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll(".kodex-project-group")).map((element) => element.getAttribute("aria-label"));
}

function rect({ top, height }: { top: number; height: number }): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 200,
    top,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function projectSummary(id: string, name: string): Project {
  return {
    createdAt: "2026-05-01T00:00:00Z",
    cwd: `/workspace/${id}`,
    id,
    name,
    updatedAt: "2026-05-01T00:00:00Z",
  };
}
