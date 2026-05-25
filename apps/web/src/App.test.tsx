import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway } from "./test/gatewayMock";

function renderApp() {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
      <App />
    </VirtuosoMockContext.Provider>,
  );
}

async function waitForTimelineReady() {
  await waitFor(() => {
    expect(document.querySelector(".kodex-timeline-virtual-root")).toHaveAttribute(
      "data-initial-bottom-aligned",
      "true",
    );
  });
}

function snapshotItem(id: string, itemType: string, payload: Record<string, unknown>) {
  return { id, itemType, rawPayload: { id, type: itemType, ...payload } };
}

function snapshotTurn(id: string, items: unknown[], status = "completed") {
  return { id, status, items, rawPayload: { id, status: { type: status }, items } };
}

function threadDetail(thread: Record<string, unknown>, turns: ReturnType<typeof snapshotTurn>[]) {
  return {
    thread,
    turns,
    liveState: thread.status === "active" ? "streaming" : "idle",
    timeline: timelineFromTurns(thread, turns),
    rawPayload: {},
  };
}

function timelineFromTurns(thread: Record<string, unknown>, turns: ReturnType<typeof snapshotTurn>[]) {
  let displayOrder = 0;
  const activeTurn = [...turns].reverse().find((turn) => !["completed", "failed", "cancelled"].includes(turn.status));
  const items = turns.flatMap((turn) =>
    turn.items.map((item) => {
      const snapshot = item as { id?: string; itemType?: string; rawPayload?: unknown };
      displayOrder += 1;
      return {
        id: `projection-${turn.id}-${snapshot.id ?? displayOrder}`,
        threadId: String(thread.id),
        turnId: turn.id,
        itemId: snapshot.id ?? `item-${displayOrder}`,
        itemType: snapshot.itemType ?? "unknown",
        status: turn.status === "completed" ? "completed" : turn.status,
        displayOrder,
        codexMethod: turn.status === "completed" ? "item/completed" : "item/upsert",
        timestampMs: displayOrder,
        payload: {
          source: "appServerSnapshot",
          turnId: turn.id,
          itemId: snapshot.id ?? `item-${displayOrder}`,
          item: snapshot.rawPayload ?? item,
          itemSnapshot: item,
        },
      };
    }),
  );
  return {
    viewRevision: 1,
    activeTurnId: activeTurn?.id ?? null,
    liveState: thread.status === "active" ? "streaming" : "idle",
    rows: canonicalRowsFromSnapshotItems(items),
    items,
  };
}

function projectionPatchEvent({
  id = "projection-patch-1",
  seq = 2,
  threadId = "thread-1",
  turnId = "turn-live",
  itemId = "agent-live",
  text = "Live update",
  displayOrder = seq,
}: {
  id?: string;
  seq?: number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  text?: string;
  displayOrder?: number;
}) {
  const item = {
    id: `projection-${turnId}-${itemId}`,
    threadId,
    turnId,
    itemId,
    itemType: "agentMessage",
    displayOrder,
    status: "running",
    timestampMs: displayOrder,
    codexMethod: "item/upsert",
    payload: {
      source: "gatewayStream",
      turnId,
      itemId,
      item: { id: itemId, type: "agentMessage", text },
      itemSnapshot: {
        id: itemId,
        itemType: "agentMessage",
        rawPayload: { id: itemId, type: "agentMessage", text },
      },
    },
  };
  return {
    id,
    seq,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    projectId: "project-1",
    threadId,
    turnId,
    itemId: null,
    payload: {
      viewRevision: seq,
      threadId,
      activeTurnId: turnId,
      liveState: "streaming",
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      rows: canonicalRowsFromSnapshotItems([item]),
      turns: [{ id: turnId, status: "running" }],
      items: [item],
    },
    receivedAt: "2026-04-30T00:00:02Z",
  };
}

type TestTimelineItem = {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  itemType: string;
  status: string;
  displayOrder: number;
  timestampMs?: number;
  payload: { item?: unknown };
};

function canonicalRowsFromSnapshotItems(items: TestTimelineItem[]) {
  const rows: unknown[] = [];
  let activityItems: TestTimelineItem[] = [];
  let fileItems: TestTimelineItem[] = [];

  const flushActivity = () => {
    if (activityItems.length === 0) {
      return;
    }
    const first = activityItems[0];
    rows.push({
      id: `activity-${first.id}`,
      kind: "activity",
      turnId: first.turnId,
      displayOrder: first.displayOrder,
      status: first.status,
      timestampMs: first.timestampMs,
      item: null,
      items: activityItems,
      fileChanges: [],
      work: null,
      collapsedRows: [],
      dividerBefore: null,
    });
    activityItems = [];
  };
  const flushFiles = () => {
    if (fileItems.length === 0) {
      return;
    }
    const first = fileItems[0];
    rows.push({
      id: `file-changes-turn-${first.turnId}`,
      kind: "file_changes",
      turnId: first.turnId,
      displayOrder: first.displayOrder,
      status: first.status,
      timestampMs: first.timestampMs,
      item: null,
      items: [],
      fileChanges: fileItems.map(fileChangeEntryFromItem),
      work: null,
      collapsedRows: [],
      dividerBefore: null,
    });
    fileItems = [];
  };

  for (const item of [...items].sort((left, right) => left.displayOrder - right.displayOrder)) {
    const kind = canonicalKind(item.itemType);
    if (kind === "file_change") {
      flushActivity();
      fileItems.push(item);
      continue;
    }
    if (isActivityKind(kind)) {
      flushFiles();
      activityItems.push(item);
      continue;
    }
    flushActivity();
    flushFiles();
    rows.push(canonicalItemRow(item, kind));
  }
  flushActivity();
  flushFiles();
  return rows;
}

function canonicalItemRow(item: TestTimelineItem, kind = canonicalKind(item.itemType)) {
  return {
    id: `item-${item.id}`,
    kind,
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    status: item.status,
    timestampMs: item.timestampMs,
    item,
    items: [],
    fileChanges: [],
    work: null,
    collapsedRows: [],
    dividerBefore: null,
  };
}

function canonicalKind(itemType: string) {
  const normalized = itemType.toLowerCase().replace(/[_-]/g, "");
  const kinds: Record<string, string> = {
    agentmessage: "assistant_message",
    assistantmessage: "assistant_message",
    collabagenttoolcall: "collab_agent_tool_call",
    commandexecution: "command_execution",
    dynamictoolcall: "dynamic_tool_call",
    filechange: "file_change",
    imageview: "image_view",
    mcptoolcall: "mcp_tool_call",
    usermessage: "user_message",
    websearch: "web_search_group",
  };
  return kinds[normalized] ?? itemType;
}

function isActivityKind(kind: string) {
  return ["collab_agent_tool_call", "command_execution", "dynamic_tool_call", "image_view", "mcp_tool_call", "web_search_group"].includes(kind);
}

function fileChangeEntryFromItem(item: TestTimelineItem) {
  const payload = item.payload.item && typeof item.payload.item === "object" ? item.payload.item as Record<string, unknown> : {};
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const first = changes[0] && typeof changes[0] === "object" ? changes[0] as Record<string, unknown> : payload;
  const path = typeof first.path === "string" ? first.path : "unknown";
  const diff = typeof first.diff === "string" ? first.diff : "";
  return {
    id: `file-change-${item.id}`,
    path,
    action: "Modified",
    additions: diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    diff,
    itemIds: [item.id],
  };
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
    window.history.replaceState(null, "", "/");
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
      "GET /v1/models": { models: [], nextCursor: null, rawPayload: {} },
      "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionsPreset: null },
    });

    renderApp();

    expect(screen.queryByRole("banner", { name: /kodex/i })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /thread/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /approvals/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /project: no project/i })).toBeInTheDocument();

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

    renderApp();

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

    renderApp();

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");
      expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    });

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /preferences/i }));

    const colorSchemeGroup = await screen.findByRole("radiogroup", { name: /color scheme/i });
    expect(within(colorSchemeGroup).getByRole("radio", { name: /paper light/i })).toHaveAttribute("aria-checked", "true");
  });

  it("renders the theme workbench route without loading gateway state", async () => {
    window.history.replaceState(null, "", "/__theme");

    renderApp();

    expect(screen.getByRole("main", { name: /theme workbench/i })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /workspace/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /paper light/i }));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");
    });
  });

  it("moves the selected color scheme with arrow keys in preferences", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    renderApp();

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

    renderApp();

    expect(await screen.findByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
  });

  it("lets the workspace sidebar grow wider from its minimum width", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    renderApp();

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

    renderApp();

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
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const gateway = mockGateway({
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
                text: "Open [feedback](/Users/example/kodex/timeline-rendering-feedback.md:2).",
              }),
            ]),
          ],
        ),
        "GET /v1/threads/thread-1/files/preview": new Response("# Timeline Feedback\nPane body\nThird line", {
          headers: { "content-type": "text/markdown" },
        }),
        "GET /v1/approvals": { approvals: [] },
        "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
      });

      renderApp();

      await userEvent.click(await screen.findByRole("link", { name: "feedback" }));
      const pane = await screen.findByRole("dialog", { name: /timeline-rendering-feedback\.md:2/i });
      expect(within(pane).getByText(/\/Users\/example\/kodex\/timeline-rendering-feedback\.md:2/i)).toBeInTheDocument();
      expect(within(pane).getByText("Pane body")).toBeInTheDocument();
      expect(within(pane).getByText("Pane body").closest("[data-line-target='true']")).toBeInTheDocument();
      expect(within(pane).getByRole("radio", { name: "Source" })).toBeChecked();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const previewRequest = gateway.callsFor("GET", "/v1/threads/thread-1/files/preview").at(-1);
      expect(previewRequest ? new URL(previewRequest.url).searchParams.get("path") : null).toBe(
        "/Users/example/kodex/timeline-rendering-feedback.md",
      );
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("renders markdown preview pane content with shared markdown components", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query.includes("min-width: 901px"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));

    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Markdown QA",
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
          name: "Markdown QA",
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
              text: "Open [rendered](/Users/example/kodex/rendered-preview.md).",
            }),
          ]),
        ],
      ),
      "GET /v1/threads/thread-1/files/preview": new Response(
        "# Rendered Preview\n\n```ts\nconst value = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |",
        { headers: { "content-type": "text/markdown" } },
      ),
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    renderApp();

    await userEvent.click(await screen.findByRole("link", { name: "rendered" }));
    const pane = await screen.findByRole("dialog", { name: /rendered-preview\.md/i });

    expect(pane).toHaveClass("kodex-mantine-modal-content");
    expect(within(pane).getByRole("radio", { name: "Preview" })).toBeChecked();
    expect(within(pane).getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(pane.querySelector(".kodex-code-block-shell")).toBeInTheDocument();
    expect(pane.querySelector(".kodex-markdown-table-scroll")).toBeInTheDocument();
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

      renderApp();

      expect(await screen.findByText("Large answer 0")).toBeInTheDocument();
      expect(screen.queryByText("Large answer 29")).not.toBeInTheDocument();
      expect(screen.getAllByText(/Large answer/).length).toBeLessThan(30);
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

    renderApp();

    expect(await screen.findByText("Large answer 0")).toBeInTheDocument();
    await waitForTimelineReady();
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
      "POST /v1/threads/thread-1/input": { payload: {} },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    renderApp();

    expect(await screen.findByText("Large answer 0")).toBeInTheDocument();
    await waitForTimelineReady();
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
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

    renderApp();

    expect(await screen.findByText("Large answer 0")).toBeInTheDocument();
    await waitForTimelineReady();
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
      selectedThreadStream?.emit(projectionPatchEvent({
        id: "live-message-1",
        seq: 2,
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "live-agent-1",
        text: "Live update while reading history",
        displayOrder: 1,
      }));
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

    renderApp();

    expect(await screen.findByText("Ran echo command-0")).toBeInTheDocument();
    expect(screen.queryByText("Ran echo command-299")).not.toBeInTheDocument();
    expect(screen.queryAllByText("Shell")).toHaveLength(0);
  });
});
