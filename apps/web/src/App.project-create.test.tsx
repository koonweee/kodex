import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project, requestJson } from "./test/mvpAppHarness";

afterEach(() => vi.restoreAllMocks());

it("registers the selected root as a native project and reuses its idempotency key after an uncertain reply", async () => {
  window.history.replaceState({}, "", "/threads/thread-1");
  const created = { ...project, id: "native-created", name: "Research", roots: [{ path: "/home/kodex/Research" }], metadata: {}, position: 1, createdAt: 1, updatedAt: 1, recencyAt: null };
  let calls = 0;
  let projects = [project];
  const gateway = mockGateway(baseRoutes({
    "GET /v1/sidebar/threads": () => ({ projects, projectThreads: {}, chatThreads: { threads: [] }, sections: [], sectionThreads: {} }),
    "GET /v1/directories": (request: Request) => {
      const path = new URL(request.url).searchParams.get("path") ?? "/home/kodex";
      return { path, homePath: "/home/kodex", parentPath: path === "/home/kodex" ? null : "/home/kodex", directories: path === "/home/kodex" ? [{ name: "Research", path: "/home/kodex/Research" }] : [] };
    },
    "POST /v1/projects": () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ code: "bad_gateway", message: "Reply lost", retryable: true }), { status: 502 });
      projects = [project, created];
      return created;
    },
  }));
  render(<App />);
  expect(await screen.findByRole("heading", { name: /^Implement frontend$/ })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: /add project/i }));
  const dialog = await screen.findByRole("dialog", { name: "Add project" });
  const form = within(dialog);
  expect(form.getByRole("button", { name: "Add project" })).toBeDisabled();
  await userEvent.click(await form.findByRole("button", { name: "Research" }));
  await form.findByText("/home/kodex/Research");
  await userEvent.click(form.getByRole("button", { name: "Use this directory" }));
  expect(form.queryByRole("button", { name: "Use this directory" })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  expect(await within(dialog).findByText("Reply lost")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(2));
  const [first, retry] = await Promise.all(gateway.callsFor("POST", "/v1/projects").map(requestJson));
  expect(first).toEqual({ name: "Research", roots: [{ path: "/home/kodex/Research" }], idempotencyKey: expect.any(String) });
  expect(retry).toEqual(first);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).not.toBeInTheDocument());
  expect(await screen.findByRole("group", { name: "Research" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Project: Research" })).toBeInTheDocument();
  const activePane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]')!;
  expect(within(activePane).getByRole("textbox", { name: "Message composer" })).toBeEnabled();
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/composer-settings").some((request) => {
    const query = new URL(request.url).searchParams;
    return query.get("projectId") === created.id && query.get("cwd") === "/home/kodex/Research";
  })).toBe(true));
});
