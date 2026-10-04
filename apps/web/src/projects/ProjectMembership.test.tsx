import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, FakeEventSource, mockGateway, project, thread, threadDetail } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeEventSource.instances = []; });

it("refreshes canonical chat details after assignment without waiting for a native notification", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const destination = { ...project, id: "other-project", name: "Research", roots: [] };
  let member = { ...thread, projectId: project.id as string | null };
  let releaseOld!: (value: unknown) => void;
  let holdNext = false;
  let oldSignal: AbortSignal | undefined;
  const gateway = mockGateway(baseRoutes({
    "GET /v1/sidebar/threads": () => ({
      projects: [project, destination],
      projectThreads: { [project.id]: { threads: member.projectId === project.id ? [member] : [] }, [destination.id]: { threads: member.projectId === destination.id ? [member] : [] } },
      chatThreads: { threads: member.projectId === null ? [member] : [] }, sections: [], sectionThreads: {},
    }),
    "GET /v1/threads/thread-1": (request: Request) => {
      if (!holdNext) return threadDetail(member);
      holdNext = false;
      oldSignal = request.signal;
      return new Promise((resolve) => { releaseOld = resolve; });
    },
    "PATCH /v1/threads/thread-1/project": () => { member = { ...member, projectId: destination.id }; return { thread: member, rawPayload: {} }; },
  }));
  render(<App />);
  const chooser = await screen.findByRole("button", { name: "Chat project: Kodex" });
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1").length).toBeGreaterThan(0));
  holdNext = true;
  act(() => {
    FakeEventSource.instances.find((source) => !source.closed && source.url.includes("includeGlobal=true"))?.emitNamed("thread_view.refresh_required", {
      seq: 10, kind: "thread_view.refresh_required", threadId: thread.id, payload: {}, createdAt: "2026-10-04T00:00:00Z",
    });
  });
  await waitFor(() => expect(releaseOld).toBeDefined());
  const readsBeforeAssignment = gateway.callsFor("GET", "/v1/threads/thread-1").length;
  await userEvent.click(chooser);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Research" }));
  await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1").length).toBeGreaterThan(readsBeforeAssignment));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { releaseOld(threadDetail(thread)); });
  expect(await screen.findByRole("button", { name: "Chat project: Research" })).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("group", { name: "Kodex" })).not.toHaveTextContent("Implement frontend");
});

it("uses canonical membership for a deep link outside the current sidebar page", async () => {
  let member = { ...thread, projectId: project.id as string | null };
  const gateway = mockGateway(baseRoutes({
    "GET /v1/sidebar/threads": { projects: [project], projectThreads: { [project.id]: { threads: [] } }, chatThreads: { threads: [] }, sections: [], sectionThreads: {} },
    "GET /v1/threads/thread-1": () => threadDetail(member),
    "PATCH /v1/threads/thread-1/project": () => { member = { ...member, projectId: null }; return { thread: member, rawPayload: {} }; },
  }));
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Chat project: Kodex" }));
  const clear = await screen.findByRole("menuitem", { name: "No project" });
  expect(clear).toBeEnabled();
  await userEvent.click(clear);
  await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/project")).toHaveLength(1));
  expect(await screen.findByRole("button", { name: "Chat project: No project" })).toBeInTheDocument();
});
