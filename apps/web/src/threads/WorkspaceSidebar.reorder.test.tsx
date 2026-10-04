import { AppShell, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, ThreadSummary } from "../api/client";
import * as instanceBoundary from "../api/GatewayInstanceBoundary";
import { createInstanceStorage } from "../api/instanceStorage";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar project reorder", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(instanceBoundary, "useGatewayInstanceStorage").mockReturnValue(createInstanceStorage("sidebar-instance"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps custom sections visible across project and chat scopes without duplicating project membership", () => {
    const section = { id: "research", name: "Research" };
    const member = threadSummary(1, { projectId: "project-1", section, name: "Section member" });
    const onSelectSectionThread = vi.fn();
    renderSidebar({
      sections: [section], sectionThreads: [member], sectionThreadsById: { [section.id]: [member] },
      onSelectSectionThread, projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: { "project-1": [threadSummary(2, { name: "Unsectioned project chat" })] },
    });
    expect(screen.getAllByRole("button", { name: "Section member" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(screen.getByRole("group", { name: "Research section" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Section member" }));
    expect(onSelectSectionThread).toHaveBeenCalledWith(member.id);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Research section" }));
    expect(screen.queryByRole("button", { name: "Section member" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("button", { name: "Expand Research section" })).toBeInTheDocument();
  });

  it("requests a native relative move when a project is dragged before another project", () => {
    const onMoveProject = vi.fn();
    const { container } = renderSidebar({
      onMoveProject,
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
    expect(onMoveProject).not.toHaveBeenCalled();

    fireEvent.dragEnd(oldProjectRow!, { dataTransfer });
    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onMoveProject).not.toHaveBeenCalled();

    fireEvent.dragStart(oldProjectRow!, { dataTransfer });
    fireEvent.dragOver(newProjectTitle!, { dataTransfer, clientY: 45 });
    fireEvent.drop(screen.getByRole("group", { name: "New" }), { dataTransfer });

    expect(projectOrder(container)).toEqual(["New", "Middle", "Old"]);
    expect(onMoveProject).toHaveBeenCalledWith("old", "new");
  });

  it("collapses older project threads behind a subdued show more toggle", () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": Array.from({ length: 7 }, (_value, index) => threadSummary(index + 1)),
      },
    });

    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 5" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 6" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 7" })).not.toBeInTheDocument();

    const showMore = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(showMore);

    expect(screen.getByRole("button", { name: "Thread 6" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 7" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Thread 6" })).not.toBeInTheDocument();
  });

  it("renders add project copy and collapses older chat threads", () => {
    const onCreateChat = vi.fn();
    renderSidebar({
      chatThreads: Array.from({ length: 7 }, (_value, index) => threadSummary(index + 1)),
      onCreateChat,
    });

    expect(screen.queryByRole("button", { name: "Start new chat from desktop header" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreateChat).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Chats section" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 5" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thread 6" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Thread 6" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Thread 6" })).not.toBeInTheDocument();
  });

  it("renders collapsed desktop sidebar as an icon rail", async () => {
    const onOpenTerminal = vi.fn();
    const onSelectChatThread = vi.fn();
    const onSelectThread = vi.fn();
    renderSidebar({
      chatThreads: [threadSummary(3, { id: "chat-recent", name: "Recent chat", updatedAt: 30 })],
      onOpenTerminal,
      onSelectChatThread,
      onSelectThread,
      projects: [projectSummary("project-1", "Project")],
      sidebarCollapsed: true,
      sidebarWidth: 44,
      threadsByProjectId: {
        "project-1": [threadSummary(1, { id: "project-recent", name: "Recent project", updatedAt: 40 })],
      },
    });

    expect(screen.getByLabelText("Workspace")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand workspace sidebar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("separator", { name: /sidebar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recent threads" }));
    const recentProjectItem = await screen.findByText("Recent project");
    expect(recentProjectItem.closest('nav[aria-label="Workspace"]')).not.toBeInTheDocument();
    fireEvent.click(recentProjectItem);
    expect(onSelectThread).toHaveBeenCalledWith("project-1", "project-recent");
    expect(onSelectChatThread).not.toHaveBeenCalled();
  });

  it("turns the expanded search action into a focused input", async () => {
    renderSidebar({
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1, { name: "Needle thread" })],
      },
    });

    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const searchInput = screen.getByLabelText("Search");
    await waitFor(() => expect(searchInput).toHaveFocus());

    fireEvent.change(searchInput, { target: { value: "needle" } });
    expect(screen.getByRole("button", { name: "Needle thread" })).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.blur(searchInput);
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });

  it("expands collapsed sidebar when search is clicked", () => {
    const onSidebarExpandClick = vi.fn();
    renderSidebar({
      onSidebarExpandClick,
      sidebarCollapsed: true,
      sidebarWidth: 44,
    });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onSidebarExpandClick).toHaveBeenCalledTimes(1);
  });

  it("shows local loading and error states for cursor-backed project pagination", () => {
    const onLoadMoreProjectThreads = vi.fn();
    const { rerender } = renderSidebar({
      onLoadMoreProjectThreads,
      projectThreadHasMoreById: { "project-1": true },
      projectThreadPaginationStateById: { "project-1": "loading" },
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": Array.from({ length: 5 }, (_value, index) => threadSummary(index + 1)),
      },
    });

    expect(screen.getByRole("button", { name: "Loading more" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Loading more" }));
    expect(onLoadMoreProjectThreads).not.toHaveBeenCalled();

    rerender(
      <MantineProvider>
        <AppShell>
          <WorkspaceSidebar
            account={null}
            approvals={[]}
            chatThreads={[]}
            hoveredThreadActionId={null}
            onArchiveThread={vi.fn()}
            onCreateChat={vi.fn()}
            onCreateProject={vi.fn()}
            onCreateThread={vi.fn()}
            onLogout={vi.fn()}
            onLoadMoreProjectThreads={onLoadMoreProjectThreads}
            onOpenPreferences={vi.fn()}
            onPinThread={vi.fn()}
            onMoveProject={vi.fn()}
            onSelectAutomations={vi.fn()}
            onSelectChatThread={vi.fn()}
            onSelectSectionThread={vi.fn()}
            onSelectProjectSettings={vi.fn()}
            onSelectThread={vi.fn()}
            onShowDebugEventsChange={vi.fn()}
            onSidebarCollapseClick={vi.fn()}
            onSidebarExpandClick={vi.fn()}
            onThreadActionHoverChange={vi.fn()}
            onUnpinThread={vi.fn()}
            pendingTitleThreadIds={new Set()}
            sectionThreads={[]}
            projectThreadHasMoreById={{ "project-1": true }}
            projectThreadPaginationStateById={{ "project-1": "error" }}
            projects={[projectSummary("project-1", "Project")]}
            selectedMainPane="thread"
            selectedProjectId={null}
            selectedThreadId={null}
            showDebugEvents={false}
            sidebarWidth={320}
            threadsByProjectId={{ "project-1": Array.from({ length: 5 }, (_value, index) => threadSummary(index + 1)) }}
          />
        </AppShell>
      </MantineProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load more threads");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(onLoadMoreProjectThreads).toHaveBeenCalledWith("project-1");
  });

  it("shows local loading state for cursor-backed chat pagination", () => {
    const onLoadMoreChatThreads = vi.fn();
    renderSidebar({
      chatThreads: Array.from({ length: 5 }, (_value, index) => threadSummary(index + 1)),
      chatThreadsHasMore: true,
      chatThreadsPaginationState: "loading",
      onLoadMoreChatThreads,
    });

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(screen.getByRole("button", { name: "Loading more" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Loading more" }));
    expect(onLoadMoreChatThreads).not.toHaveBeenCalled();
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
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    });

    const projectsToggle = screen.getByRole("button", { name: "Collapse Projects section" });
    expect(screen.getByText("Project")).toBeInTheDocument();

    fireEvent.click(projectsToggle);

    expect(projectsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Project")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Projects section" }));

    expect(screen.getByText("Project")).toBeInTheDocument();
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

  it("rehydrates collapsed project rows only for the same confirmed instance", () => {
    const props = {
      projects: [projectSummary("project-1", "Project")],
      threadsByProjectId: {
        "project-1": [threadSummary(1)],
      },
    };
    const first = renderSidebar(props);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Project" }));
    first.unmount();

    const second = renderSidebar(props);

    expect(screen.getByRole("button", { name: "Expand Project" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Thread 1" })).not.toBeInTheDocument();
    second.unmount();

    vi.mocked(instanceBoundary.useGatewayInstanceStorage).mockReturnValue(createInstanceStorage("other-instance"));
    renderSidebar(props);

    expect(screen.getByRole("button", { name: "Collapse Project" })).toHaveAttribute("aria-expanded", "true");
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
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeInTheDocument();

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
  const queryClient = new QueryClient();
  return render(
    <MantineProvider>
      <AppShell>
        <WorkspaceSidebar
          account={null}
          approvals={[]}
          chatThreads={[]}
          hoveredThreadActionId={null}
          onArchiveThread={vi.fn()}
          onCreateChat={vi.fn()}
          onCreateProject={vi.fn()}
          onCreateThread={vi.fn()}
          onLogout={vi.fn()}
          onOpenPreferences={vi.fn()}
          onPinThread={vi.fn()}
          onMoveProject={vi.fn()}
          onSelectAutomations={vi.fn()}
          onSelectChatThread={vi.fn()}
          onSelectSectionThread={vi.fn()}
          onSelectProjectSettings={vi.fn()}
          onSelectThread={vi.fn()}
          onShowDebugEventsChange={vi.fn()}
          onSidebarCollapseClick={vi.fn()}
          onSidebarExpandClick={vi.fn()}
          onThreadActionHoverChange={vi.fn()}
          onUnpinThread={vi.fn()}
          pendingTitleThreadIds={new Set()}
          sectionThreads={[]}
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
    { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
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
    createdAt: 1,
    roots: [{ path: `/workspace/${id}` }],
    metadata: {},
    position: 0,
    id,
    name,
    updatedAt: 1,
  };
}

function threadSummary(index: number, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    parentThreadId: null, canAcceptDirectInput: null,
    createdAt: index,
    cwd: "/workspace/project-1",
    projectId: "project-1",
    id: `thread-${index}`,
    name: `Thread ${index}`,
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: index,
    ...overrides,
  };
}
