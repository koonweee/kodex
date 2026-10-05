import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { Project } from "../api/client";
import { App, baseRoutes, mockGateway, project, requestJson, thread } from "../test/mvpAppHarness";

afterEach(() => vi.restoreAllMocks());

it("renames sparsely and deletes only the project registry entry", async () => {
  let projects: Project[] = [{ ...project, metadata: { retained: "native-other-client" } }, { ...project, id: "second", name: "Second", roots: [], position: 1 }];
  let projectId: string | null = project.id;
  const gateway = mockGateway(baseRoutes({
    "GET /v1/sidebar/threads": () => ({
      projects,
      projectThreads: Object.fromEntries(projects.map((entry) => [entry.id, { threads: entry.id === projectId ? [{ ...thread, projectId }] : [] }])),
      chatThreads: { threads: projectId ? [] : [{ ...thread, projectId }] }, pinnedThreads: { threads: [] },
    }),
    "PATCH /v1/projects/project-1": async (request: Request) => {
      const patch = await request.json();
      projects = projects.map((entry) => entry.id === project.id ? { ...entry, ...patch } : entry);
      return projects.find((entry) => entry.id === project.id);
    },
    "DELETE /v1/projects/project-1": () => { projects = projects.filter((entry) => entry.id !== project.id); projectId = null; return new Response(null, { status: 204 }); },
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Project settings for Kodex" }));
  const name = await screen.findByRole("textbox", { name: "Project name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByRole("heading", { name: "Renamed" })).toBeInTheDocument();
  expect(await requestJson(gateway.callsFor("PATCH", "/v1/projects/project-1")[0])).toEqual({ name: "Renamed" });
  expect(projects[0].metadata).toEqual({ retained: "native-other-client" });
  expect(projects[0].roots).toEqual(project.roots);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete project" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete Renamed?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Renamed" })).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Chats" }));
  expect(await screen.findByRole("button", { name: "Implement frontend" })).toBeInTheDocument();
  expect(gateway.calls.some((request) => request.method === "DELETE" && new URL(request.url).pathname.startsWith("/v1/threads"))).toBe(false);
});
