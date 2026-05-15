import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  baseRoutes,
  mockGateway,
  requestJson,
  secondThread,
  thread,
} from "./test/mvpAppHarness";

const automationsCss = readFileSync(join(process.cwd(), "src/styles/automations.css"), "utf8");

function goTo(path: string) {
  window.history.replaceState(null, "", path);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const automation = {
  id: "automation-1",
  name: "Daily status",
  prompt: "Summarize current repo state.",
  targetThreadId: "thread-1",
  schedule: {
    startAt: "2026-05-07T09:00:00Z",
    repeatEvery: { value: 30, unit: "seconds" },
  },
  nextRunAt: "2026-05-07T09:30:00Z",
  status: "active",
  pausedReason: null,
  lastRunAt: null,
  lastQueuedInputId: null,
  lastError: null,
  consecutiveFailureCount: 0,
  createdAt: "2026-05-07T08:00:00Z",
  updatedAt: "2026-05-07T08:00:00Z",
};

describe("Automations frontend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("keeps automations layout width-based while touch ergonomics are coarse-pointer scoped", () => {
    const widthSection = cssSection("@media (max-width: 900px)", "@media (pointer: coarse), (any-pointer: coarse)");
    const touchSection = cssSection("@media (pointer: coarse), (any-pointer: coarse)");

    expect(widthSection).toContain(".kodex-automation-table-container table");
    expect(widthSection).toContain(".kodex-automation-table-row");
    expect(widthSection).toContain(".kodex-automation-modal-grid");
    expect(widthSection).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(widthSection).not.toContain(".kodex-automation-mobile-input input");
    expect(widthSection).not.toContain("font-size: 16px;");
    expect(widthSection).not.toContain("env(safe-area-inset-bottom)");
    expect(widthSection).not.toContain("width: 44px;");

    expect(touchSection).toContain(".kodex-automation-mobile-input input");
    expect(touchSection).toContain("font-size: 16px;");
    expect(touchSection).toContain("env(safe-area-inset-bottom)");
    expect(touchSection).toContain("width: 44px;");
    expect(touchSection).toContain("min-height: 44px;");
  });

  it("opens the Automations pane from the sidebar without rendering the composer", async () => {
    goTo("/");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/automations": { automations: [automation] },
      }),
    );

    render(<App />);

    await openAutomationsFromSidebar();

    expect(window.location.pathname).toBe("/automations");
    const main = screen.getByRole("main", { name: /automations/i });
    expect(await within(main).findByRole("heading", { name: "Automations" })).toBeInTheDocument();
    expect(await within(main).findByText("Daily status", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(within(main).getByRole("table").closest(".kodex-automation-table-paper")).toHaveClass(
      "kodex-mantine-paper-root",
    );
    expect(within(main).queryByLabelText(/message composer/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("GET", "/v1/automations")).toHaveLength(1);
    });
  });

  it("keeps Automations route and mobile selector panel state in browser navigation", async () => {
    goTo("/automations?panel=threads");
    mockGateway(baseRoutes({ "GET /v1/automations": { automations: [] } }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Automations" })).toBeInTheDocument();
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");
    expect(window.location.pathname + window.location.search).toBe("/automations?panel=threads");
  });

  it("applies automation upsert and delete events from the gateway stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    goTo("/automations");
    mockGateway(baseRoutes({ "GET /v1/automations": { automations: [] } }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Automations" })).toBeInTheDocument();
    const stream = FakeEventSource.instances.find((instance) => instance.url.includes("/v1/events"));
    expect(stream).toBeDefined();

    act(() => {
      stream?.emitNamed("automation.item_upsert", {
        id: "event-automation-upsert",
        seq: 2,
        kind: "automation.item_upsert",
        threadId: "thread-2",
        projectId: null,
        turnId: null,
        itemId: null,
        codexMethod: null,
        payload: { ...automation, id: "automation-2", name: "Weekly audit", targetThreadId: "thread-2" },
        receivedAt: "2026-05-07T08:00:01Z",
      });
    });

    expect(await screen.findByText("Weekly audit")).toBeInTheDocument();

    act(() => {
      stream?.emitNamed("automation.item_deleted", {
        id: "event-automation-delete",
        seq: 3,
        kind: "automation.item_deleted",
        threadId: null,
        projectId: null,
        turnId: null,
        itemId: null,
        codexMethod: null,
        payload: { id: "automation-2" },
        receivedAt: "2026-05-07T08:00:02Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Weekly audit")).not.toBeInTheDocument();
    });
  });

  it("refetches when a live automation event arrives before the snapshot resolves", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    goTo("/automations");
    const firstSnapshot = deferred<{ automations: typeof automation[] }>();
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/automations": () =>
          gateway.callsFor("GET", "/v1/automations").length === 1
            ? firstSnapshot.promise
            : { automations: [{ ...automation, id: "automation-live", name: "Live automation" }] },
      }),
    );

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Automations" })).toBeInTheDocument();

    const stream = FakeEventSource.instances.find((instance) => instance.url.includes("/v1/events"));
    expect(stream).toBeDefined();
    act(() => {
      stream?.emitNamed("automation.item_upsert", {
        id: "event-live",
        seq: 2,
        kind: "automation.item_upsert",
        threadId: "thread-1",
        projectId: null,
        turnId: null,
        itemId: null,
        codexMethod: null,
        payload: { ...automation, id: "automation-live", name: "Live automation" },
        receivedAt: "2026-05-07T08:00:01Z",
      });
    });

    await act(async () => {
      firstSnapshot.resolve({ automations: [automation] });
      await firstSnapshot.promise;
    });

    await waitFor(() => {
      expect(gateway.callsFor("GET", "/v1/automations")).toHaveLength(2);
    });
    expect(screen.getByText("Live automation")).toBeInTheDocument();
    expect(screen.queryByText("Daily status")).not.toBeInTheDocument();
  });

  it("still loads the first automation snapshot after a live event arrives before opening the pane", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    goTo("/threads/thread-1");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/automations": { automations: [automation] },
      }),
    );

    render(<App />);

    const stream = await waitFor(() => {
      const eventStream = FakeEventSource.instances.find((instance) => instance.url.includes("/v1/events"));
      expect(eventStream).toBeDefined();
      return eventStream;
    });
    act(() => {
      stream!.emitNamed("automation.item_upsert", {
        id: "event-before-open",
        seq: 2,
        kind: "automation.item_upsert",
        threadId: "thread-1",
        projectId: null,
        turnId: null,
        itemId: null,
        codexMethod: null,
        payload: { ...automation, id: "automation-live", name: "Live automation" },
        receivedAt: "2026-05-07T08:00:01Z",
      });
    });

    expect(gateway.callsFor("GET", "/v1/automations")).toHaveLength(0);
    await openAutomationsFromSidebar();

    expect(await screen.findByText("Daily status")).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("GET", "/v1/automations")).toHaveLength(1);
    });
  });

  it("creates an automation from the details modal", async () => {
    goTo("/threads/thread-1");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/automations": { automations: [] },
        "POST /v1/automations": async (request: Request) => ({
          automation: {
            ...automation,
            ...(await requestJson(request)),
            id: "automation-created",
            createdAt: "2026-05-07T08:30:00Z",
            updatedAt: "2026-05-07T08:30:00Z",
            nextRunAt: "2026-05-07T09:30:00Z",
            status: "active",
            pausedReason: null,
            lastRunAt: null,
            lastQueuedInputId: null,
            lastError: null,
            consecutiveFailureCount: 0,
          },
        }),
      }),
    );

    render(<App />);

    await openAutomationsFromSidebar();
    const addButton = await waitFor(() => {
      const enabledButton = screen
        .getAllByRole("button", { name: /add automation/i })
        .find((button) => !button.hasAttribute("disabled"));
      expect(enabledButton).toBeDefined();
      return enabledButton!;
    });
    await userEvent.click(addButton);
    expect(await screen.findByRole("dialog", { name: /new automation/i })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Morning review");
    await userEvent.type(screen.getByLabelText("Automation prompt"), "## Check status");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/automations")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/automations")[0])).resolves.toMatchObject({
      name: "Morning review",
      prompt: "## Check status",
      targetThreadId: "thread-1",
      schedule: { repeatEvery: { value: 30, unit: "minutes" } },
    });
    expect(await screen.findByText("Morning review")).toBeInTheDocument();
  });

  it("edits, pauses, resumes, and confirms delete from the details modal", async () => {
    goTo("/automations");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/automations": { automations: [automation] },
        "PATCH /v1/automations/automation-1": async (request: Request) => ({
          automation: {
            ...automation,
            ...(await requestJson(request)),
            name: "Updated status",
            updatedAt: "2026-05-07T08:45:00Z",
          },
        }),
        "POST /v1/automations/automation-1/pause": {
          automation: { ...automation, name: "Updated status", status: "paused", pausedReason: null },
        },
        "POST /v1/automations/automation-1/resume": {
          automation: { ...automation, name: "Updated status", status: "active", pausedReason: null },
        },
        "DELETE /v1/automations/automation-1": { id: "automation-1" },
      }),
    );

    render(<App />);

    const main = screen.getByRole("main", { name: /automations/i });
    const automationRow = await within(main).findByRole("row", { name: /daily status/i });
    await userEvent.click(automationRow);
    expect(await screen.findByRole("dialog", { name: /automation details/i })).toBeInTheDocument();

    const nameInput = screen.getByRole("textbox", { name: /name/i });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Updated status");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/automations/automation-1")).toHaveLength(1);
    });
    expect(await screen.findByText("Updated status")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Updated status"));
    await userEvent.click(await screen.findByRole("button", { name: /^pause$/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/automations/automation-1/pause")).toHaveLength(1);
    });
    expect(await screen.findByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/automations/automation-1/resume")).toHaveLength(1);
    });

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    expect(gateway.callsFor("DELETE", "/v1/automations/automation-1")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /^confirm delete$/i }));
    await waitFor(() => {
      expect(gateway.callsFor("DELETE", "/v1/automations/automation-1")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Updated status")).not.toBeInTheDocument();
    });
  });

  it("returns from Automations to a selected thread", async () => {
    goTo("/automations");
    mockGateway(
      baseRoutes({
        "GET /v1/automations": { automations: [] },
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Automations" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /second thread/i }));

    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/thread-2");
  });
});

async function openAutomationsFromSidebar() {
  await userEvent.click(await screen.findByRole("button", { name: /account settings/i }));
  await userEvent.click(await screen.findByText("Automations"));
}

function cssSection(startMarker: string, endMarker?: string) {
  const start = automationsCss.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = endMarker ? automationsCss.indexOf(endMarker, start + startMarker.length) : -1;
  return automationsCss.slice(start, end === -1 ? undefined : end);
}
