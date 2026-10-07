import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project, requestJson, setInitialWorkspacePaneState, thread, threadDetail } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function restoreProjectDraft(cwd = "/outside-roots") {
  setInitialWorkspacePaneState({
    activePaneId: "project-draft",
    dockviewLayout: null,
    panes: [{ id: "project-draft", kind: "thread", target: { mode: "draft", projectId: project.id, cwd }, title: "New project chat" }],
    schemaVersion: 1,
  });
}

it.each([{ roots: [] }, { roots: [{ path: "/first" }, { path: "/second" }] }])("blocks project drafts without one root instead of offering a directory override (%j)", async ({ roots }) => {
  window.history.replaceState({}, "", "/");
  const gateway = mockGateway(baseRoutes({ "GET /v1/projects": { projects: [{ ...project, roots }] } }));
  restoreProjectDraft();
  render(<App />);
  const error = await screen.findByText("Edit this project to choose one root directory before starting a chat.");
  const pane = error.closest<HTMLElement>(".kodex-thread-pane")!;
  expect(screen.queryByRole("textbox", { name: "Working directory" })).not.toBeInTheDocument();
  expect(await within(pane).findByRole("textbox", { name: /message composer/i })).toBeDisabled();
  expect(gateway.callsFor("GET", "/v1/composer-settings").every((request) => !new URL(request.url).searchParams.has("projectId"))).toBe(true);
  expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
});

it("uses the sole project root for defaults, skills and thread creation despite a restored draft override", async () => {
  window.history.replaceState({}, "", "/");
  const root = project.roots[0].path;
  const created = { ...thread, id: "new-thread", cwd: root, name: "New execution" };
  const gateway = mockGateway(baseRoutes({
    "POST /v1/threads": { thread: created },
    "POST /v1/threads/new-thread/attach": threadDetail(created),
  }));
  restoreProjectDraft();
  render(<App />);
  const pane = (await screen.findByRole("button", { name: "Project: Kodex" })).closest<HTMLElement>(".kodex-thread-pane")!;
  const composer = within(pane).getByRole("textbox", { name: /message composer/i });
  expect(screen.queryByRole("textbox", { name: "Working directory" })).not.toBeInTheDocument();
  await userEvent.type(composer, "$skill");
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/skills").some((request) => new URL(request.url).searchParams.get("cwd") === root)).toBe(true));
  await userEvent.clear(composer);
  await userEvent.type(composer, "Run at the project root");
  await userEvent.click(within(pane).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/threads")[0])).toMatchObject({ projectId: project.id, cwd: root });
  expect(gateway.callsFor("GET", "/v1/composer-settings").some((request) => {
    const params = new URL(request.url).searchParams;
    return params.get("projectId") === project.id && params.get("cwd") === root;
  })).toBe(true);
  expect(gateway.callsFor("GET", "/v1/skills").every((request) => new URL(request.url).searchParams.get("cwd") !== "/outside-roots")).toBe(true);
});

it("uses the sole project root for integrated terminals despite a restored draft override", async () => {
  window.history.replaceState({}, "", "/");
  const gateway = mockGateway(baseRoutes({
    "GET /v1/terminals": { terminals: [] },
    "POST /v1/terminals": () => new Response(JSON.stringify({ message: "Terminal fixture stopped after request" }), { status: 503 }),
  }));
  restoreProjectDraft();
  render(<App />);
  await screen.findByRole("button", { name: "Project: Kodex" });
  await userEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Terminal" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(1));
  const request = await requestJson(gateway.callsFor("POST", "/v1/terminals")[0]);
  expect(request).toMatchObject({ projectId: project.id });
  expect(request).not.toHaveProperty("cwd");
});

it.each([{ roots: [] }, { roots: [{ path: "/one" }, { path: "/two" }] }])("directs invalid project terminal launches to project editing without a directory chooser (%j)", async ({ roots }) => {
  window.history.replaceState({}, "", "/");
  const gateway = mockGateway(baseRoutes({
    "GET /v1/projects": { projects: [{ ...project, roots }] },
    "GET /v1/terminals": { terminals: [] },
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Project settings for Kodex" }));
  await userEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Terminal" }));
  expect(await screen.findByRole("dialog", { name: "Project root required" })).toHaveTextContent("Edit this project to choose one root directory before opening a terminal.");
  expect(screen.queryByRole("textbox", { name: "Working directory" })).not.toBeInTheDocument();
  expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(0);
});

it("preserves an existing chat's native cwd after its project root changes", async () => {
  window.history.replaceState({}, "", "/threads/thread-1");
  const gateway = mockGateway(baseRoutes({
    "GET /v1/projects": { projects: [{ ...project, roots: [{ path: "/updated-project-root" }] }] },
    "GET /v1/terminals": { terminals: [] },
    "POST /v1/terminals": () => new Response(JSON.stringify({ message: "Terminal fixture stopped after request" }), { status: 503 }),
  }));
  render(<App />);
  await userEvent.type(await screen.findByRole("textbox", { name: /message composer/i }), "$skill");
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/skills").some((request) => new URL(request.url).searchParams.get("cwd") === thread.cwd)).toBe(true));
  await userEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Terminal" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(1));
  const request = await requestJson(gateway.callsFor("POST", "/v1/terminals")[0]);
  expect(request).toMatchObject({ cwd: thread.cwd });
  expect(request).not.toHaveProperty("projectId");
});
