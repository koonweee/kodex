import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, mockGateway, project, requestJson } from "./test/mvpAppHarness";

afterEach(() => vi.restoreAllMocks());

it("registers a rootless native project and reuses its idempotency key after an uncertain reply", async () => {
  window.history.replaceState({}, "", "/threads/thread-1");
  const created = { ...project, id: "native-created", name: "Research", roots: [], metadata: {}, position: 1, createdAt: 1, updatedAt: 1, recencyAt: null };
  let calls = 0;
  let projects = [project];
  const gateway = mockGateway(baseRoutes({
    "GET /v1/sidebar/threads": () => ({ projects, projectThreads: {}, chatThreads: { threads: [] }, sections: [], sectionThreads: {} }),
    "POST /v1/projects": () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ code: "bad_gateway", message: "Reply lost", retryable: true }), { status: 502 });
      projects = [project, created];
      return created;
    },
  }));
  render(<App />);
  expect(await screen.findByRole("button", { name: "Chat project: Kodex" })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: /add project/i }));
  const dialog = await screen.findByRole("dialog", { name: "Add project" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Research");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  expect(await within(dialog).findByText("Reply lost")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(2));
  const [first, retry] = await Promise.all(gateway.callsFor("POST", "/v1/projects").map(requestJson));
  expect(first).toEqual({ name: "Research", roots: [], idempotencyKey: expect.any(String) });
  expect(retry).toEqual(first);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).not.toBeInTheDocument());
  expect(await screen.findByRole("group", { name: "Research" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Project: Research" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Working directory" })).toHaveValue("");
});
