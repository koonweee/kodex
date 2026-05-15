import { AppShell, MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, ThreadSummary } from "../api/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar project reorder", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

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

    expect(screen.getByRole("button", { name: "Start new chat from desktop header" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Start new chat from desktop header" }));
    expect(onCreateChat).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Chats section" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Thread 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Thread 2" })).not.toBeInTheDocument();
  });

  it("renders pinned threads above projects with pin controls", () => {
    const onSelectPinnedThread = vi.fn();
    const onUnpinThread = vi.fn();
    const pinnedThread = threadSummary(1, { id: "thread-pinned", name: "Pinned thread", pinnedAt: "2026-05-06T12:00:00Z" });
    const { container } = renderSidebar({
      onSelectPinnedThread,
      onUnpinThread,
      pinnedThreads: [pinnedThread],
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(2)],
      },
    });

    const pinnedSection = container.querySelector(".kodex-pinned-section");
    const projectsSection = container.querySelector(".kodex-projects-section-row");
    expect(pinnedSection).toBeInTheDocument();
    expect(projectsSection).toBeInTheDocument();
    expect(pinnedSection!.compareDocumentPosition(projectsSection!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pinned thread" }));
    expect(onSelectPinnedThread).toHaveBeenCalledWith("thread-pinned");

    fireEvent.click(screen.getByRole("button", { name: "Unpin thread" }));
    expect(onUnpinThread).toHaveBeenCalledWith("thread-pinned");
  });

  it("uses one projects/chats switch on desktop and filters pinned threads by scope", () => {
    renderSidebar({
      chatThreads: [threadSummary(3, { id: "chat-thread", name: "Chat thread", cwd: "/workspace/chats/2026-05-06" })],
      pinnedThreads: [
        threadSummary(1, {
          id: "project-pinned",
          name: "Pinned project thread",
          cwd: "/workspace/project-1",
          pinnedAt: "2026-05-06T12:00:00Z",
        }),
        threadSummary(2, {
          id: "chat-pinned",
          name: "Pinned chat thread",
          cwd: "/workspace/chats/2026-05-06",
          pinnedAt: "2026-05-06T12:01:00Z",
        }),
      ],
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(4, { id: "project-thread", name: "Project thread" })],
      },
    });

    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "Pinned project thread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pinned chat thread" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chat thread" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "Pinned chat thread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pinned project thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat thread" })).toBeInTheDocument();
  });

  it("opens automations from the sidebar settings menu", async () => {
    const onSelectAutomations = vi.fn();
    renderSidebar({ onSelectAutomations });

    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
    fireEvent.click(await screen.findByText("Automations"));

    expect(onSelectAutomations).toHaveBeenCalledTimes(1);
  });

  it("collapses a project when its title row is clicked", () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      selectedProjectId: "project-1",
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    const projectToggle = screen.getByRole("button", { name: "Collapse Project" });
    expect(projectToggle.closest(".kodex-project-row")?.querySelector(".kodex-sidebar-row-leading .lucide-folder-open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();

    fireEvent.click(projectToggle);

    expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    expect(projectToggle.closest(".kodex-project-row")?.querySelector(".kodex-sidebar-row-leading .lucide-folder")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 1" })).not.toBeInTheDocument();

    fireEvent.click(projectToggle);

    expect(projectToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
  });

  it("collapses and expands the Projects section from the section row", () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      projectFormOpen: true,
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    const projectsToggle = screen.getByRole("button", { name: "Collapse Projects section" });
    expect(screen.getByText("Directory")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();

    fireEvent.click(projectsToggle);

    expect(projectsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Directory")).not.toBeInTheDocument();
    expect(screen.queryByText("Project")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Projects section" }));

    expect(screen.getByText("Directory")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("collapses and expands the Pinned section from the section row", () => {
    renderSidebar({
      pinnedThreads: [threadSummary(1, { id: "thread-pinned", name: "Pinned thread", pinnedAt: "2026-05-06T12:00:00Z" })],
      projects: [projectSummary("project-1", "Project")],
    });

    const pinnedToggle = screen.getByRole("button", { name: "Collapse Pinned section" });
    expect(screen.getByRole("button", { name: "Pinned thread" })).toBeInTheDocument();

    fireEvent.click(pinnedToggle);

    expect(pinnedToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Pinned thread" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Pinned section" }));

    expect(screen.getByRole("button", { name: "Pinned thread" })).toBeInTheDocument();
  });

  it("collapses and expands the Chats section from the section row", () => {
    renderSidebar({
      chatThreads: [threadSummary(1)],
    });

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    const chatsToggle = screen.getByRole("button", { name: "Collapse Chats section" });
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();

    fireEvent.click(chatsToggle);

    expect(chatsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Thread 1" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Chats section" }));

    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
  });

  it("rehydrates collapsed project and chat sections from local storage", () => {
    const first = renderSidebar({
      chatThreads: [threadSummary(2, { id: "chat-thread", name: "Chat thread" })],
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { id: "project-thread", name: "Project thread" })],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse Projects section" }));
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Chats section" }));
    first.unmount();

    renderSidebar({
      chatThreads: [threadSummary(2, { id: "chat-thread", name: "Chat thread" })],
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { id: "project-thread", name: "Project thread" })],
      },
    });

    expect(screen.getByRole("button", { name: "Expand Projects section" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(screen.getByRole("button", { name: "Expand Chats section" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Project thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chat thread" })).not.toBeInTheDocument();
  });

  it("rehydrates collapsed project rows from local storage", () => {
    const first = renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse Project" }));
    first.unmount();

    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    expect(screen.getByRole("button", { name: "Expand Project" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Thread 1" })).not.toBeInTheDocument();
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

  it("keeps compact density at the sidebar root on narrow fine-pointer viewports", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query === "(max-width: 900px)" || query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { status: "active" })],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Workspace")).toHaveAttribute("data-density", "compact");
    });
    expect(screen.getByText("Project").closest(".kodex-sidebar-row")).toHaveClass("kodex-project-row");
    expect(screen.getByRole("button", { name: "Thread 1" }).closest(".kodex-sidebar-row")).toHaveClass(
      "kodex-thread-list-button",
    );

    matchMedia.mockRestore();
  });

  it("applies shared touch density at the sidebar root on narrow coarse-pointer devices", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query === "(max-width: 900px)" || query === "(any-pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { status: "active" })],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Workspace")).toHaveAttribute("data-density", "touch");
    });

    matchMedia.mockRestore();
  });

  it("applies shared touch density at the sidebar root on coarse-pointer devices", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query === "(any-pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { status: "active" })],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Workspace")).toHaveAttribute("data-density", "touch");
    });

    matchMedia.mockRestore();
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
          onPinThread={vi.fn()}
          onProjectCwdChange={vi.fn()}
          onProjectDirectoryCreateCancel={vi.fn()}
          onProjectFormOpenChange={vi.fn()}
          onReorderProjects={vi.fn()}
          onSelectAutomations={vi.fn()}
          onSelectChatThread={vi.fn()}
          onSelectPinnedThread={vi.fn()}
          onSelectProjectSettings={vi.fn()}
          onSelectThread={vi.fn()}
          onShowDebugEventsChange={vi.fn()}
          onSidebarResizeKeyDown={vi.fn()}
          onSidebarResizePointerDown={vi.fn()}
          onThreadActionHoverChange={vi.fn()}
          onUnpinThread={vi.fn()}
          pendingTitleThreadIds={new Set()}
          pinnedThreads={[]}
          projectCwd=""
          projectDirectoryCreatePending={false}
          projectFormOpen={false}
          projects={[]}
          selectedMainPane="thread"
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

function threadSummary(index: number, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
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
    ...overrides,
  };
}
