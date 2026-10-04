import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project } from "./test/mvpAppHarness";

describe("project navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps project details and chat navigation without remote preview controls or requests", async () => {
    const gateway = mockGateway(baseRoutes());
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /project settings for kodex/i }));

    expect(window.location.pathname).toBe("/projects/project-1");
    const main = await screen.findByRole("main", { name: "Project" });
    expect(await within(main).findByRole("heading", { name: "Kodex" })).toBeInTheDocument();
    expect(within(main).getByText(project.cwd)).toBeInTheDocument();
    expect(within(main).queryAllByRole("button", { name: /add service|add preview|restart proxy/i })).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/projects/project-1/previews")).toHaveLength(0);

    const workspace = screen.getByRole("navigation", { name: "Workspace" });
    await userEvent.click(within(workspace).getByRole("button", { name: /implement frontend/i }));
    const threadPane = await screen.findByRole("main", { name: "Thread workspace" });
    expect(await within(threadPane).findByText("Hello from Codex")).toBeInTheDocument();
    expect(within(workspace).getByRole("button", { name: "Terminal" })).toBeEnabled();

    await userEvent.click(within(workspace).getByRole("button", { name: /project settings for kodex/i }));
    await userEvent.click(within(workspace).getByRole("button", { name: /new thread|create thread in kodex/i }));
    await waitFor(() => expect(screen.getByRole("main", { name: "Thread workspace" })).toBeInTheDocument());
    const draftPane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]');
    expect(draftPane).not.toBeNull();
    expect(within(draftPane!).getByRole("textbox", { name: /message composer/i })).toHaveValue("");
    expect(within(workspace).getByRole("button", { name: "Terminal" })).toBeEnabled();
    expect(gateway.callsFor("GET", "/v1/projects/project-1/previews")).toHaveLength(0);
  });
});
