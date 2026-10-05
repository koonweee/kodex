import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project, thread } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); });

for (const scope of ["project", "chat"] as const) {
  it(`keeps pagination reachable when the ${scope} first page contains only pinned chats`, async () => {
    window.history.replaceState({}, "", "/");
    const member = { ...thread, pinned: true, projectId: scope === "project" ? project.id : null };
    const ordinary = { ...member, id: "ordinary", name: "Later ordinary chat", pinned: false };
    const gateway = mockGateway(baseRoutes({
      "GET /v1/sidebar/threads": {
        projects: [project], projectThreads: { [project.id]: { threads: scope === "project" ? [member] : [], nextCursor: scope === "project" ? "more" : null } },
        chatThreads: { threads: scope === "chat" ? [member] : [], nextCursor: scope === "chat" ? "more" : null },
        pinnedThreads: { threads: [member] },
      },
      [scope === "project" ? "GET /v1/threads" : "GET /v1/chats/threads"]: { threads: [ordinary], nextCursor: null, rawPayload: {} },
    }));
    render(<App />);
    const sidebar = within(screen.getByRole("navigation", { name: "Workspace" }));
    expect(await sidebar.findByRole("group", { name: "Pinned" })).toHaveTextContent(thread.name);
    if (scope === "chat") await userEvent.click(sidebar.getByRole("button", { name: "Chats" }));
    await userEvent.click(await sidebar.findByRole("button", { name: "Show more" }));
    expect(await sidebar.findByRole("button", { name: ordinary.name })).toBeInTheDocument();
    const endpoint = scope === "project" ? "/v1/threads" : "/v1/chats/threads";
    expect(new URL(gateway.callsFor("GET", endpoint)[0].url).searchParams.get("cursor")).toBe("more");
    expect(sidebar.getAllByRole("button", { name: thread.name })).toHaveLength(1);
  });
}
