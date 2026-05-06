import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway } from "./test/gatewayMock";

function snapshotItem(id: string, itemType: string, payload: Record<string, unknown>) {
  return { id, itemType, rawPayload: { id, type: itemType, ...payload } };
}

function snapshotTurn(id: string, items: unknown[], status = "completed") {
  return { id, status, items, rawPayload: { id, status: { type: status }, items } };
}

function threadDetail(thread: Record<string, unknown>, turns: ReturnType<typeof snapshotTurn>[]) {
  return { thread, turns, liveState: thread.status === "active" ? "streaming" : "idle", rawPayload: {} };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    return undefined;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

describe("App shell", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-kodex-color-scheme");
    document.documentElement.removeAttribute("data-mantine-color-scheme");
    document.documentElement.removeAttribute("style");
    vi.restoreAllMocks();
  });

  it("renders the MVP shell with debug menu in the sidebar footer", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
      "GET /v1/models": { models: [], nextCursor: null, rawPayload: {} },
      "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionsPreset: null },
    });

    render(<App />);

    expect(screen.queryByRole("banner", { name: /kodex/i })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /thread/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /approvals/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();

    expect(screen.queryByRole("button", { name: /status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /debug options/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /show debug events/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/gateway/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/app-server/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/trusted network/i)).not.toBeInTheDocument();
  });

  it("opens preferences from the sidebar settings menu and switches color schemes", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "oled-black");
    });

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /preferences/i }));

    expect(await screen.findByRole("dialog", { name: /preferences/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /appearance/i })).toHaveAttribute("data-active", "true");

    const colorSchemeGroup = screen.getByRole("radiogroup", { name: /color scheme/i });
    await userEvent.click(within(colorSchemeGroup).getByRole("radio", { name: /dracula/i }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "dracula");
      expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark");
    });
    expect(window.localStorage.getItem("kodex-color-scheme")).toBe("dracula");
  });

  it("hydrates a persisted light color scheme before opening preferences", async () => {
    window.localStorage.setItem("kodex-color-scheme", "paper-light");
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");
      expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    });

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /preferences/i }));

    const colorSchemeGroup = await screen.findByRole("radiogroup", { name: /color scheme/i });
    expect(within(colorSchemeGroup).getByRole("radio", { name: /paper light/i })).toHaveAttribute("aria-checked", "true");
  });

  it("moves the selected color scheme with arrow keys in preferences", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /preferences/i }));

    const colorSchemeGroup = await screen.findByRole("radiogroup", { name: /color scheme/i });
    const oledBlack = within(colorSchemeGroup).getByRole("radio", { name: /oled black/i });
    oledBlack.focus();
    expect(oledBlack).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(within(colorSchemeGroup).getByRole("radio", { name: /paper light/i })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");

    await userEvent.keyboard("{ArrowUp}");
    expect(within(colorSchemeGroup).getByRole("radio", { name: /oled black/i })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "oled-black");
  });

  it("keeps the shell visible when optional app-server-backed calls fail", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
    });

    render(<App />);

    expect(await screen.findByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
  });

  it("lets the workspace sidebar grow wider from its minimum width", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    const resizeHandle = screen.getByRole("separator", { name: /resize workspace sidebar/i });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "292");

    fireEvent.pointerDown(resizeHandle, { clientX: 292, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(resizeHandle).toHaveAttribute("aria-valuenow", "420");
    expect(screen.getByRole("navigation", { name: /workspace/i })).toHaveStyle({ width: "420px" });
  });

  it("keeps the thread header and composer outside the timeline scroll region and toggles debug events locally", async () => {
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Investigate timeline rendering with a deliberately long generated title",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Investigate timeline rendering with a deliberately long generated title",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn("turn-1", [
            snapshotItem("answer-1", "agentMessage", { text: "Visible answer" }),
          ]),
        ],
      ),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    const thread = await screen.findByRole("main", { name: /thread/i });
    expect(await within(thread).findByText(/visible answer/i)).toBeInTheDocument();
    expect(thread.querySelector(".kodex-thread-header")).toBeInTheDocument();
    expect(thread.querySelector(".kodex-timeline-scroll")).toBeInTheDocument();
    expect(thread.querySelector(".kodex-composer")).toBeInTheDocument();
    expect(within(thread).queryByText(/event stream/i)).not.toBeInTheDocument();
    expect(within(thread).queryByText(/turn\/started/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /show debug events/i }));

    expect(await within(thread).findAllByText(/item\/completed/i)).not.toHaveLength(0);
    expect(within(thread).getByText(/"text": "Visible answer"/i)).toBeInTheDocument();
  });

  it("opens local markdown links in a right-side preview pane", async () => {
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Timeline QA",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Timeline QA",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn("turn-1", [
            snapshotItem("answer-1", "agentMessage", {
              text: "Open [feedback](/Users/example/kodex/timeline-rendering-feedback.md).",
            }),
          ]),
        ],
      ),
      "GET /v1/threads/thread-1/files/preview": new Response("# Timeline Feedback\n\nPane body", {
        headers: { "content-type": "text/markdown" },
      }),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "feedback" }));

    const pane = await screen.findByRole("dialog", { name: /timeline-rendering-feedback\.md/i });
    expect(within(pane).getByRole("heading", { name: /timeline feedback/i })).toBeInTheDocument();
    expect(within(pane).getByText(/pane body/i)).toBeInTheDocument();
  });

  it("mounts a bounded row window for large timelines", async () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollTo = vi.fn(function (this: HTMLElement, _options?: ScrollToOptions) {
      return undefined;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    try {
      mockGateway({
        "GET /v1/projects": {
          projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
        },
        "GET /v1/threads": {
          threads: [
            {
              id: "thread-1",
              name: "Large thread",
              cwd: "/home/example/kodex",
              status: "idle",
              source: "local",
              preview: "",
              rawPayload: {},
              createdAt: 1777500000,
              updatedAt: 1777501200,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(
          {
            id: "thread-1",
            name: "Large thread",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
          [
            snapshotTurn(
              "turn-1",
              Array.from({ length: 30 }, (_, index) =>
                snapshotItem(`answer-${index}`, "agentMessage", { text: `Large answer ${index}` }),
              ),
            ),
          ],
        ),
        "GET /v1/approvals": { approvals: [] },
        "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
      });

      render(<App />);

      expect(await screen.findByText("Large answer 29")).toBeInTheDocument();
      expect(screen.queryByText("Large answer 1")).not.toBeInTheDocument();
      expect(screen.getAllByText(/Large answer/)).toHaveLength(12);
      await waitFor(() => {
        const timelineScrollToCalls = scrollTo.mock.calls.filter((_, index) =>
          scrollTo.mock.contexts[index].classList.contains("kodex-timeline-scroll"),
        );
        expect(
          timelineScrollToCalls.some(([options]) => {
            if (typeof options !== "object" || options === null || !("top" in options)) {
              return false;
            }
            return Number(options.top) > 0;
          }),
        ).toBe(false);
      });
    } finally {
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      }
    }
  });

  it("shows and hides the scroll-to-bottom button when the user leaves and returns to bottom", async () => {
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Large thread",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Large thread",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn(
            "turn-1",
            Array.from({ length: 30 }, (_, index) =>
              snapshotItem(`answer-${index}`, "agentMessage", { text: `Large answer ${index}` }),
            ),
          ),
        ],
      ),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    expect(await screen.findByText("Large answer 29")).toBeInTheDocument();
    const scrollRegion = document.querySelector(".kodex-timeline-scroll") as HTMLElement;
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 3600 },
      scrollTop: { configurable: true, writable: true, value: 3200 },
    });
    fireEvent.scroll(scrollRegion);
    expect(screen.queryByRole("button", { name: /scroll to bottom/i })).not.toBeInTheDocument();

    scrollRegion.scrollTop = 600;
    fireEvent.scroll(scrollRegion);
    const scrollButton = await screen.findByRole("button", { name: /scroll to bottom/i });
    expect(scrollButton).toBeInTheDocument();

    await userEvent.click(scrollButton);
    expect(scrollRegion.scrollTop).toBe(3200);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).not.toBeInTheDocument();
    });
  });

  it("keeps the user's scroll position when sending while scrolled up", async () => {
    const gateway = mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Large thread",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Large thread",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn(
            "turn-1",
            Array.from({ length: 30 }, (_, index) =>
              snapshotItem(`answer-${index}`, "agentMessage", { text: `Large answer ${index}` }),
            ),
          ),
        ],
      ),
      "POST /v1/threads/thread-1/turns": { payload: {} },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    expect(await screen.findByText("Large answer 29")).toBeInTheDocument();
    const scrollRegion = document.querySelector(".kodex-timeline-scroll") as HTMLElement;
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 3600 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    });
    fireEvent.scroll(scrollRegion);
    expect(await screen.findByRole("button", { name: /scroll to bottom/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Follow live after send");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(scrollRegion.scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: /scroll to bottom/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
  });

  it("keeps the user's scroll position when selected-thread stream messages arrive while scrolled up", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Large thread",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Large thread",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn(
            "turn-1",
            Array.from({ length: 30 }, (_, index) =>
              snapshotItem(`answer-${index}`, "agentMessage", { text: `Large answer ${index}` }),
            ),
          ),
        ],
      ),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    expect(await screen.findByText("Large answer 29")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.some((instance) => instance.url.includes("threadId=thread-1"))).toBe(true));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    const scrollRegion = document.querySelector(".kodex-timeline-scroll") as HTMLElement;
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 3600 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    });
    fireEvent.scroll(scrollRegion);
    expect(await screen.findByRole("button", { name: /scroll to bottom/i })).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emit({
        id: "live-message-1",
        seq: 1,
        kind: "timeline.item_upsert",
        codexMethod: "item/upsert",
        projectId: "project-1",
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "live-agent-1",
        payload: {
          source: "gatewayStream",
          item: { id: "live-agent-1", type: "agentMessage", text: "Live update while reading history" },
        },
        receivedAt: "2026-04-30T00:00:00Z",
      });
    });

    expect(await screen.findByText(/live update while reading history/i)).toBeInTheDocument();
    expect(scrollRegion.scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: /scroll to bottom/i })).toBeInTheDocument();
  });

  it("bounds mounted nested activity items in activity-heavy timelines", async () => {
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Activity thread",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/threads/thread-1": threadDetail(
        {
          id: "thread-1",
          name: "Activity thread",
          cwd: "/home/example/kodex",
          status: "idle",
          source: "local",
          preview: "",
          rawPayload: {},
          createdAt: 1777500000,
          updatedAt: 1777501200,
        },
        [
          snapshotTurn(
            "turn-1",
            Array.from({ length: 300 }, (_, index) =>
              snapshotItem(`cmd-${index}`, "commandExecution", {
                command: `echo command-${index}`,
                output: "ok",
              }),
            ),
          ),
        ],
      ),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    expect(await screen.findByText("Ran echo command-299")).toBeInTheDocument();
    expect(screen.queryByText("Ran echo command-0")).not.toBeInTheDocument();
    expect(screen.queryAllByText("Shell")).toHaveLength(0);
  });
});
