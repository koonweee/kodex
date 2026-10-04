import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project, requestJson, thread, threadDetail } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([{ roots: [] }, { roots: [{ path: "/first" }, { path: "/second" }] }])("requires a project draft directory and sends that same directory to config, skills and native create (%j)", async ({ roots }) => {
  window.history.replaceState({}, "", "/");
  const scoped = { ...project, roots };
  const created = { ...thread, id: "new-thread", cwd: "/outside-roots", name: "New execution" };
  const gateway = mockGateway(baseRoutes({
    "GET /v1/projects": { projects: [scoped] },
    "POST /v1/threads": { thread: created },
    "GET /v1/threads/new-thread": threadDetail(created),
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Create thread in Kodex" }));
  const cwd = await screen.findByRole("textbox", { name: "Working directory" });
  const pane = cwd.closest<HTMLElement>(".kodex-thread-pane")!;
  const composer = within(pane).getByRole("textbox", { name: /message composer/i });
  expect(cwd).toHaveValue("");
  expect(composer).toBeDisabled();
  expect(gateway.callsFor("GET", "/v1/composer-settings").every((request) => !new URL(request.url).searchParams.has("projectId"))).toBe(true);
  await userEvent.type(cwd, "/outside-roots");
  await userEvent.type(composer, "$skill");
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/skills").some((request) => new URL(request.url).searchParams.get("cwd") === "/outside-roots")).toBe(true));
  await userEvent.clear(composer);
  await userEvent.type(composer, "Run here");
  await userEvent.click(within(pane).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/threads")[0])).toMatchObject({ projectId: project.id, cwd: "/outside-roots" });
  expect(gateway.callsFor("GET", "/v1/composer-settings").some((request) => {
    const params = new URL(request.url).searchParams;
    return params.get("projectId") === project.id && params.get("cwd") === "/outside-roots";
  })).toBe(true);
});

it("uses the chosen draft directory for integrated terminal launch", async () => {
  window.history.replaceState({}, "", "/");
  const gateway = mockGateway(baseRoutes({
    "GET /v1/projects": { projects: [{ ...project, roots: [] }] },
    "GET /v1/terminals": { terminals: [] },
    "POST /v1/terminals": () => new Response(JSON.stringify({ message: "Terminal fixture stopped after request" }), { status: 503 }),
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Create thread in Kodex" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Working directory" }), "/chosen-context");
  await userEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Terminal" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/terminals")[0])).toMatchObject({ cwd: "/chosen-context" });
});

it("asks for a directory before launching a terminal from an ambiguous project", async () => {
  const gateway = mockGateway(baseRoutes({
    "GET /v1/projects": { projects: [{ ...project, roots: [{ path: "/one" }, { path: "/two" }] }] },
    "GET /v1/terminals": { terminals: [] },
    "POST /v1/terminals": () => new Response(JSON.stringify({ message: "Terminal fixture stopped after request" }), { status: 503 }),
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Project settings for Kodex" }));
  await userEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Terminal" }));
  const dialog = await screen.findByRole("dialog", { name: "Terminal working directory" });
  expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(0);
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Working directory" }), "/another-directory");
  await userEvent.click(within(dialog).getByRole("button", { name: "Open terminal" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/terminals")).toHaveLength(1));
  expect(await requestJson(gateway.callsFor("POST", "/v1/terminals")[0])).toMatchObject({ cwd: "/another-directory" });
});
