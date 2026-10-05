import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, FakeEventSource, mockGateway, project, thread } from "../test/mvpAppHarness";

const snapshot = {
  projects: [project], projectThreads: { [project.id]: { threads: [thread] } },
  chatThreads: { threads: [] }, sections: [], sectionThreads: {},
};
const failure = () => new Response(JSON.stringify({ message: "database is locked" }), { status: 500 });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeEventSource.instances = []; });

it("explains an initial sidebar failure and explicitly retries its canonical snapshot", async () => {
  window.history.replaceState({}, "", "/");
  let failing = true;
  const gateway = mockGateway(baseRoutes({ "GET /v1/sidebar/threads": () => failing ? failure() : snapshot }));
  render(<App />);
  const sidebar = within(screen.getByRole("navigation", { name: "Workspace" }));
  expect(await sidebar.findByRole("alert")).toHaveTextContent("Could not load sidebar");
  expect(sidebar.queryByText("No projects")).not.toBeInTheDocument();
  expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1);
  failing = false;
  await userEvent.click(sidebar.getByRole("button", { name: "Retry" }));
  expect(await sidebar.findByRole("group", { name: project.name })).toBeInTheDocument();
  await waitFor(() => expect(sidebar.queryByRole("alert")).not.toBeInTheDocument());
  expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(2);
});

it("retains a good sidebar when canonical refill fails and clears the error after an explicit retry", async () => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("EventSource", FakeEventSource);
  let failing = false;
  const gateway = mockGateway(baseRoutes({ "GET /v1/sidebar/threads": () => failing ? failure() : snapshot }));
  render(<App />);
  const sidebar = within(screen.getByRole("navigation", { name: "Workspace" }));
  expect(await sidebar.findByRole("group", { name: project.name })).toHaveTextContent(thread.name);
  await waitFor(() => expect(FakeEventSource.instances.some((source) => !source.closed && source.url.includes("includeGlobal=true"))).toBe(true));
  const initial = FakeEventSource.instances.find((source) => !source.closed && source.url.includes("includeGlobal=true"))!;
  failing = true;
  act(() => { initial.emitNamed("project.changed", {
    id: "refill", seq: 1, kind: "project.changed", payload: { projectId: project.id, changeType: "updated" }, receivedAt: "2026-10-05T00:00:00Z",
  }); });
  expect(await sidebar.findByRole("alert")).toHaveTextContent("Could not load sidebar");
  expect(sidebar.getByRole("group", { name: project.name })).toHaveTextContent(thread.name);
  expect(sidebar.queryByText("No projects")).not.toBeInTheDocument();
  const failedReads = gateway.callsFor("GET", "/v1/sidebar/threads").length;
  failing = false;
  await userEvent.click(sidebar.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sidebar.queryByRole("alert")).not.toBeInTheDocument());
  expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(failedReads + 1);
  expect(sidebar.getByRole("group", { name: project.name })).toHaveTextContent(thread.name);
});
