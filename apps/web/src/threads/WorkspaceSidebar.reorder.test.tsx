import { AppShell, MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Project, ThreadSummary } from "../api/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar project reorder", () => {
  it("emits a persisted order when a project is dragged before another project", () => {
    const onReorderProjects = vi.fn();
    const { container } = renderSidebar({
      onReorderProjects,
      projects: [
        projectSummary("new", "New"),
        projectSummary("middle", "Middle"),
        projectSummary("old", "Old"),
      ],
    });

    const data = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "",
      effectAllowed: "",
      getData: (type: string) => data.get(type) ?? "",
      setDragImage: vi.fn(),
      setData: (type: string, value: string) => data.set(type, value),
    };
    const oldProjectTitle = screen.getByText("Old").closest(".kodex-project-title");
    const oldProjectRow = oldProjectTitle?.closest(".kodex-project-row");
    const newProjectTitle = screen.getByText("New").closest(".kodex-project-title");
    const newProjectRow = newProjectTitle?.closest(".kodex-project-row");
    expect(oldProjectTitle).toBeInTheDocument();
    expect(newProjectTitle).toBeInTheDocument();
    expect(oldProjectRow).toBeInTheDocument();
    expect(newProjectRow).toBeInTheDocument();
    vi.spyOn(newProjectRow!, "getBoundingClientRect").mockReturnValue(rect({ top: 40, height: 20 }));

    fireEvent.dragStart(oldProjectRow!, { dataTransfer });
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(oldProjectRow, 12, 0);
    fireEvent.dragOver(screen.getByRole("group", { name: "New" }), { dataTransfer, clientY: 45 });
    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);

    fireEvent.dragOver(newProjectTitle!, { dataTransfer, clientY: 45 });
    expect(projectOrder(container)).toEqual(["Old", "New", "Middle"]);
    expect(onReorderProjects).not.toHaveBeenCalled();

    fireEvent.dragEnd(oldProjectRow!, { dataTransfer });
    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onReorderProjects).not.toHaveBeenCalled();

    fireEvent.dragStart(oldProjectRow!, { dataTransfer });
    fireEvent.dragOver(newProjectTitle!, { dataTransfer, clientY: 45 });
    fireEvent.drop(screen.getByRole("group", { name: "New" }), { dataTransfer });

    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onReorderProjects).toHaveBeenCalledWith(["old", "new", "middle"]);
  });

  it("collapses older project threads behind a subdued show more toggle", () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": Array.from({ length: 7 }, (_value, index) => threadSummary(index + 1)),
      },
    });

    expect(screen.getByRole("button", { name: "Thread 7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 1" })).not.toBeInTheDocument();

    const showMore = screen.getByRole("button", { name: "Show more" });
    expect(showMore).toHaveClass("kodex-thread-list-more-button");
    fireEvent.click(showMore);

    expect(screen.getByRole("button", { name: "Thread 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();
  });

  it("renders add project copy and collapses older chat threads", () => {
    const onCreateChat = vi.fn();
    renderSidebar({
      chatThreads: Array.from({ length: 7 }, (_value, index) => threadSummary(index + 1)),
      onCreateChat,
      projectFormOpen: true,
    });

    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreateChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Thread 7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Thread 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();
  });

  it("does not collapse a project when its title row is clicked", () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      selectedProjectId: "project-1",
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    fireEvent.click(screen.getByText("Project"));

    expect(screen.queryByRole("button", { name: /project \/workspace\/project-1/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
  });

  it("does not mark the project title active when a thread or draft thread is selected", () => {
    const { unmount } = renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      selectedProjectId: "project-1",
      selectedThreadId: "thread-1",
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    expect(screen.getByText("Project").closest(".kodex-project-title")).not.toHaveAttribute("data-active", "true");

    unmount();
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      selectedProjectId: "project-1",
      selectedThreadId: null,
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    expect(screen.getByText("Project").closest(".kodex-project-title")).not.toHaveAttribute("data-active", "true");
  });
});

function renderSidebar(overrides: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  return render(
    <MantineProvider>
      <AppShell>
        <WorkspaceSidebar
          account={null}
          approvals={[]}
          chatThreads={[]}
          hoveredThreadActionId={null}
          isSidebarResizing={false}
          loginState={{}}
          onArchiveThread={vi.fn()}
          onCancelLogin={vi.fn()}
          onCreateChat={vi.fn()}
          onCreateProject={vi.fn()}
          onCreateThread={vi.fn()}
          onLogin={vi.fn()}
          onLogout={vi.fn()}
          onOpenPreferences={vi.fn()}
          onProjectCwdChange={vi.fn()}
          onProjectDirectoryCreateCancel={vi.fn()}
          onProjectFormOpenChange={vi.fn()}
          onReorderProjects={vi.fn()}
          onSelectChatThread={vi.fn()}
          onSelectThread={vi.fn()}
          onShowDebugEventsChange={vi.fn()}
          onSidebarResizeKeyDown={vi.fn()}
          onSidebarResizePointerDown={vi.fn()}
          onThreadActionHoverChange={vi.fn()}
          pendingTitleThreadIds={new Set()}
          projectCwd=""
          projectDirectoryCreatePending={false}
          projectFormOpen={false}
          projects={[]}
          selectedProjectId={null}
          selectedThreadId={null}
          showDebugEvents={false}
          sidebarWidth={320}
          threadsByProjectId={{}}
          {...overrides}
        />
      </AppShell>
    </MantineProvider>,
  );
}

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

function threadSummary(index: number): ThreadSummary {
  return {
    createdAt: index,
    cwd: "/workspace/project-1",
    id: `thread-${index}`,
    name: `Thread ${index}`,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: index,
  };
}
