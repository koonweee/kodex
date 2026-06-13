import { expect, test, type Page, type Route } from "@playwright/test";

const project = {
  id: "project-1",
  name: "Kodex",
  cwd: "/home/example/kodex",
  createdAt: "2026-04-30T00:00:00Z",
  updatedAt: "2026-04-30T00:00:00Z",
};

const thread = {
  id: "thread-1",
  name: "Frontend MVP",
  cwd: project.cwd,
  status: "idle",
  source: "local",
  preview: "Build the web client",
  lastCompletedAgentTurnSeq: null,
  seenCompletedAgentTurnSeq: 0,
  unreadCompletedAgentTurn: false,
  rawPayload: {},
  createdAt: 1777500000,
  updatedAt: 1777501200,
};

const approval = {
  id: "approval-1",
  requestId: "request-1",
  threadId: thread.id,
  turnId: "turn-1",
  itemId: "item-approval",
  method: "command_execution",
  status: "pending",
  payload: { command: "cargo test", cwd: project.cwd, reason: "Verify changes" },
  response: null,
  createdAt: "2026-04-30T00:00:00Z",
  resolvedAt: null,
};

type TestTurn = {
  id: string;
  status: string;
  items: Array<{ id: string; itemType: string; rawPayload: unknown; skillMentions?: unknown[] }>;
  startedAt?: number;
  completedAt?: number;
  rawPayload?: unknown;
};

function threadDetailBody(sourceThread: Record<string, unknown>, turns: TestTurn[] = [], liveState = "idle") {
  return {
    thread: sourceThread,
    turns,
    liveState,
    timeline: timelineFromTurns(sourceThread, turns, liveState),
    rawPayload: {},
  };
}

function timelineFromTurns(sourceThread: Record<string, unknown>, turns: TestTurn[], liveState: string) {
  let displayOrder = 0;
  const activeTurn = [...turns].reverse().find((turn) => !["completed", "failed", "cancelled"].includes(turn.status));
  const items = turns.flatMap((turn) =>
    turn.items.map((item) => {
      displayOrder += 1;
      return {
        id: `snapshot-${turn.id}-${item.id}`,
        threadId: String(sourceThread.id),
        turnId: turn.id,
        itemId: item.id,
        itemType: item.itemType,
        status: turn.status === "completed" ? "completed" : turn.status,
        displayOrder,
        codexMethod: turn.status === "completed" ? "item/completed" : "item/upsert",
        timestampMs: displayOrder,
        payload: {
          source: "appServerSnapshot",
          turnId: turn.id,
          itemId: item.id,
          item: item.rawPayload,
          itemSnapshot: item,
        },
      };
    }),
  );
  return {
    viewRevision: 1,
    activeTurnId: activeTurn?.id ?? null,
    liveState,
    rows: canonicalRowsFromSnapshotItems(items),
    items,
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

function activeThreadPane(page: Page) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
}

function composerInActiveThreadPane(page: Page) {
  return activeThreadPane(page).getByLabel(/message composer/i);
}

function sendButtonInActiveThreadPane(page: Page) {
  return activeThreadPane(page).getByRole("button", { name: /send message/i });
}

function modelButtonInActiveThreadPane(page: Page, name: RegExp) {
  return activeThreadPane(page).getByRole("button", { name });
}

async function selectModelInActiveThreadPane(page: Page, modelName: string) {
  await activeThreadPane(page).getByRole("button", { name: /model:/i }).click();
  await page.getByRole("menuitem", { name: modelName, exact: true }).click();
}

async function openFrontendMvpThread(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /frontend mvp/i }).click();
  await expect(activeThreadPane(page).getByRole("heading", { name: /frontend mvp/i })).toBeVisible();
}

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
  const payload = item.payload.item && typeof item.payload.item === "object" ? (item.payload.item as Record<string, unknown>) : {};
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const first = changes[0] && typeof changes[0] === "object" ? (changes[0] as Record<string, unknown>) : payload;
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

test.beforeEach(async ({ page }) => {
  await mockGateway(page);
});

test("creates and selects a project", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".kodex-project-title").filter({ hasText: "Kodex" })).toBeVisible();
  await page.getByRole("button", { name: /add project/i }).first().click();
  await page.getByLabel(/directory/i).fill("/tmp/scratch");
  await page.getByRole("button", { name: /add project/i }).last().click();

  await expect(page.locator(".kodex-project-title").filter({ hasText: "Scratch" })).toBeVisible();
});

test("creates a thread and submits a turn", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /create thread in kodex/i }).click();
  await composerInActiveThreadPane(page).fill("Implement the next milestone");
  await sendButtonInActiveThreadPane(page).click();
  await expect(composerInActiveThreadPane(page)).toBeEmpty();
});

test("renders selected thread snapshot output", async ({ page }) => {
  await openFrontendMvpThread(page);

  await expect(activeThreadPane(page).getByText(/snapshot assistant output/i)).toBeVisible();
});

test("renders app surface as a workspace pane and submits from the frame", async ({ page }) => {
  const interactiveSession = {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    csp: { connectDomains: [], resourceDomains: [] },
    displayModes: ["pane"],
    documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
    fallbackContent: "Mockup chooser",
    grants: { canOpenLinks: false, canSendMessage: true, canUpdateModelContext: false, resources: [], tools: [] },
    bridgeToken: "bridge-token-1",
    id: "session-1",
    provenance: { source: "test" },
    permissions: {},
    provider: "generated",
    resourceMimeType: "text/html",
    resourceUri: "ui://kodex/generated/session-1",
    revision: 1,
    status: "active",
    submitAvailable: true,
    submittedAt: null,
    submittedMessage: null,
    submittedMetadata: null,
    submittedRevision: null,
    threadId: thread.id,
    title: "Mockup chooser",
    updatedAt: "2026-04-30T00:00:00Z",
  };
  let appSurfaceSubmitted = false;
  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
      return;
    }

    if (key === "GET /v1/threads/thread-1/app-surface") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: appSurfaceSubmitted
            ? {
                ...interactiveSession,
                status: "submitted",
                submitAvailable: false,
                submittedAt: "2026-04-30T00:00:05Z",
                submittedMessage: "Pick mockup A",
                submittedMetadata: { choice: "a" },
                submittedRevision: 1,
              }
            : interactiveSession,
        }),
      });
      return;
    }

    if (key === "GET /v1/app-surfaces/session-1/document") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: `<!doctype html>
          <html>
            <body style="font-family: system-ui; margin: 0; padding: 16px">
              <h1>Mockup chooser</h1>
              <p>Compare two responsive concepts.</p>
              <button onclick="window.parent.postMessage({jsonrpc:'2.0', id:'submit-1', method:'ui/message', params:{role:'user', content:{type:'text', text:'Pick mockup A'}, _meta:{choice:'a'}}}, '*')">Choose A</button>
            </body>
          </html>`,
      });
      return;
    }

    if (key === "POST /v1/app-surfaces/session-1/bridge") {
      appSurfaceSubmitted = true;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "submit-1",
          result: { input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-app-surface" } } },
        }),
      });
      return;
    }

    const response = await responseFor(key, route);
    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await page.setViewportSize({ width: 1800, height: 820 });
  await openFrontendMvpThread(page);

  const frontendThreadPane = page.locator(".kodex-thread-pane").filter({
    has: page.getByRole("heading", { name: /frontend mvp/i }),
  });
  await expect(frontendThreadPane.getByText(/snapshot assistant output/i)).toBeVisible();
  await page.getByRole("button", { name: /open app surface/i }).click();

  const appSurfacePane = page.locator(".kodex-app-surface-pane");
  await expect(page.getByTitle(/app surface: mockup chooser/i)).toBeVisible();
  await expect(appSurfacePane).toBeVisible();
  await expect(appSurfacePane.getByRole("button", { name: /hide app surface/i })).toHaveCount(0);
  await expect(appSurfacePane.locator(".kodex-app-surface-header")).toHaveCount(0);
  const desktopFrameLayout = await appSurfacePane.evaluate((pane) => {
    const frame = pane.querySelector(".kodex-app-surface-frame-wrap");
    if (!frame) {
      throw new Error("Missing app surface layout nodes");
    }
    const paneBox = pane.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    return {
      frameBottom: frameBox.bottom,
      frameHeight: frameBox.height,
      paneBottom: paneBox.bottom,
      paneHeight: paneBox.height,
    };
  });
  expect(desktopFrameLayout.paneBottom - desktopFrameLayout.frameBottom).toBeLessThanOrEqual(10);
  expect(desktopFrameLayout.frameHeight).toBeGreaterThanOrEqual(desktopFrameLayout.paneHeight - 16);

  const frameSubmit = page
    .frameLocator('iframe[title="App surface: Mockup chooser"]')
    .frameLocator('iframe[title="App surface content"]')
    .getByRole("button", { name: "Choose A" });
  await frameSubmit.click();
  await expect(page.getByText(/submitted/i)).toBeVisible();
});

test("opens idle historical snapshots without unread or stop state after refresh interval", async ({ page }) => {
  await openFrontendMvpThread(page);

  await expect(activeThreadPane(page).getByText(/snapshot assistant output/i)).toBeVisible();
  await expect(page.locator(".kodex-thread-unread-agent-turn-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /stop turn/i })).toHaveCount(0);
  await expect(sendButtonInActiveThreadPane(page)).toBeVisible();
  await page.waitForTimeout(5500);
  await expect(page.locator(".kodex-thread-unread-agent-turn-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /stop turn/i })).toHaveCount(0);
  await expect(sendButtonInActiveThreadPane(page)).toBeVisible();
});

test("keeps long timeline content inside the thread viewer", async ({ page }) => {
  const longWord = "supercalifragilistic".repeat(24);
  const longCommand = `node -e "console.log('${"wide-output".repeat(20)}')"`;
  const longOutput = "0123456789abcdef".repeat(80);
  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
      return;
    }

    if (key === "GET /v1/events") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
      return;
    }

    if (key === "GET /v1/approvals") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvals: [] }),
      });
      return;
    }

    if (key !== "GET /v1/threads/thread-1") {
      const response = await responseFor(key, route);
      await route.fulfill({
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response.body),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...threadDetailBody(thread, [
          {
            id: "turn-1",
            status: "completed",
            rawPayload: {},
            items: [
              {
                id: "assistant-long",
                itemType: "agentMessage",
                rawPayload: { id: "assistant-long", type: "agentMessage", text: longWord },
              },
              {
                id: "command-long",
                itemType: "commandExecution",
                rawPayload: {
                  id: "command-long",
                  type: "commandExecution",
                  command: longCommand,
                  output: `${longOutput}\n`,
                },
              },
            ],
          },
        ]),
      }),
    });
  });

  await page.setViewportSize({ width: 720, height: 760 });
  await page.goto("/threads/thread-1");
  await expect(page.getByText(longWord)).toBeVisible();

  const viewer = page.locator(".kodex-timeline-scroll");
  const cards = page.locator(".kodex-turn-group, .kodex-timeline-item, .kodex-activity-group");
  const viewerBox = await viewer.boundingBox();
  expect(viewerBox).not.toBeNull();
  const cardBoxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.max(...cardBoxes)).toBeLessThanOrEqual(Math.ceil(viewerBox!.width));

  const commandGroup = page.locator(".kodex-activity-group-title").filter({ hasText: /^Ran / }).first();
  await expect(commandGroup).toHaveCSS("text-overflow", "ellipsis");
  await commandGroup.locator("xpath=ancestor::summary").click();

  const commandSummary = page.locator(".kodex-activity-title").filter({ hasText: /^Ran / }).first();
  await commandSummary.scrollIntoViewIfNeeded();
  await expect(commandSummary).toBeVisible();
  await expect(commandSummary).toHaveCSS("text-overflow", "ellipsis");
  await commandSummary.locator("xpath=ancestor::summary").click();

  const commandOutput = page.locator(".kodex-command-panel .kodex-timeline-output").first();
  await expect(commandOutput).toBeVisible();
  const outputMetrics = await commandOutput.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    whiteSpace: getComputedStyle(node).whiteSpace,
  }));
  expect(outputMetrics.whiteSpace).toBe("pre");
  expect(outputMetrics.scrollWidth).toBeGreaterThan(outputMetrics.clientWidth);
});

test("keeps followed live output pinned to the scroll parent bottom", async ({ page }) => {
  const turnsForLiveText = (liveText: string): TestTurn[] => [
    {
      id: "turn-1",
      status: "completed",
      startedAt: 1777500001,
      completedAt: 1777500002,
      rawPayload: {},
      items: [
        {
          id: "user-1",
          itemType: "userMessage",
          rawPayload: { id: "user-1", type: "userMessage", text: "Generate a long answer." },
        },
        ...Array.from({ length: 14 }, (_, index) => ({
          id: `assistant-seed-${index}`,
          itemType: "agentMessage",
          rawPayload: {
            id: `assistant-seed-${index}`,
            type: "agentMessage",
            text: `Follow seed ${index}\n\n${"The timeline should stay pinned while output grows. ".repeat(10)}`,
          },
        })),
      ],
    },
    {
      id: "turn-2",
      status: "running",
      startedAt: 1777500003,
      rawPayload: {},
      items: [
        {
          id: "assistant-live",
          itemType: "agentMessage",
          rawPayload: {
            id: "assistant-live",
            type: "agentMessage",
            text: liveText,
          },
        },
      ],
    },
  ];
  const threadBody = (liveText: string) => threadDetailBody({ ...thread, status: "active" }, turnsForLiveText(liveText), "streaming");
  const patchTimeline = timelineFromTurns(
    { ...thread, status: "active" },
    turnsForLiveText(`Live growth marker\n\n${"More assistant output. ".repeat(120)}`),
    "streaming",
  );
  let releasePatch: (() => void) | null = null;
  const patchReleased = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });

  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await patchReleased;
      const event = {
        id: "event-live-growth",
        seq: 2,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        itemId: "assistant-live",
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-2",
        payload: {
          ...patchTimeline,
          pendingApprovalRequests: [],
          pendingUserInputRequests: [],
          scope: "full_snapshot",
          threadId: thread.id,
          turns: [
            { id: "turn-1", status: "completed", startedAt: 1777500001, completedAt: 1777500002 },
            { id: "turn-2", status: "running", startedAt: 1777500003 },
          ],
          viewRevision: 2,
        },
        receivedAt: "2026-04-30T00:00:03Z",
      };
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: `event: thread_view.patch\ndata: ${JSON.stringify(event)}\n\n`,
      });
      return;
    }

    const response =
      key === "GET /v1/threads/thread-1"
        ? { body: threadBody("Initial live output") }
        : key === "POST /v1/threads/thread-1/attach"
          ? { body: { disposition: "resumed", thread: { ...thread, status: "active" }, rawPayload: {} } }
          : key === "GET /v1/approvals"
            ? { body: { approvals: [] } }
            : await responseFor(key, route);

    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await page.setViewportSize({ width: 820, height: 760 });
  await page.goto("/threads/thread-1");
  await expect(page.getByText("Follow seed 13")).toBeVisible();

  const viewer = page.locator(".kodex-timeline-scroll");
  await viewer.evaluate((node) => {
    const scrollElement = node as HTMLElement;
    scrollElement.scrollTop = scrollElement.scrollHeight - scrollElement.clientHeight - 20;
    scrollElement.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".kodex-scroll-to-bottom")).toHaveCount(0);

  releasePatch?.();
  await expect(page.getByText("Live growth marker")).toBeVisible();
  await expect.poll(async () => viewer.evaluate((node) => {
    const scrollElement = node as HTMLElement;
    return Math.round(scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight);
  })).toBe(0);
  await expect(page.locator(".kodex-scroll-to-bottom")).toHaveCount(0);
});

test("keeps large file changes and following skill messages from overlapping", async ({ page }) => {
  const skillText = "$implement-review-loop continue after the files changed block";
  const skillMention = {
    start: 0,
    end: "$implement-review-loop".length,
    name: "implement-review-loop",
    path: "/skills/implement-review-loop/SKILL.md",
    displayName: "Implement Review Loop",
    brandColor: "#7c3aed",
  };
  const fileChangeItem = (index: number) => ({
    id: `file-${index}`,
    itemType: "fileChange",
    rawPayload: {
      id: `file-${index}`,
      type: "fileChange",
      changes: [
        {
          kind: "update",
          path: `src/generated-${index}.ts`,
          diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`,
        },
      ],
    },
  });
  const timelineItems = (fileCount: number) => {
    let displayOrder = 0;
    const item = (
      turnId: string,
      source: { id: string; itemType: string; rawPayload: unknown; skillMentions?: unknown[] },
    ) => {
      displayOrder += 1;
      return {
        id: `snapshot-${turnId}-${source.id}`,
        threadId: thread.id,
        turnId,
        itemId: source.id,
        itemType: source.itemType,
        status: "completed",
        displayOrder,
        codexMethod: "item/completed",
        timestampMs: displayOrder,
        payload: {
          source: "appServerSnapshot",
          turnId,
          itemId: source.id,
          item: source.rawPayload,
          itemSnapshot: source,
        },
      };
    };
    return [
      item("turn-1", {
        id: "user-1",
        itemType: "userMessage",
        rawPayload: { id: "user-1", type: "userMessage", text: "Please inspect files." },
      }),
      ...Array.from({ length: fileCount }, (_, index) => item("turn-1", fileChangeItem(index))),
      item("turn-1", {
        id: "answer-1",
        itemType: "agentMessage",
        rawPayload: { id: "answer-1", type: "agentMessage", text: "Finished changing files.", phase: "final_answer" },
      }),
      item("turn-2", {
        id: "user-2",
        itemType: "userMessage",
        rawPayload: { id: "user-2", type: "userMessage", text: skillText },
        skillMentions: [skillMention],
      }),
    ];
  };
  const threadBody = (fileCount: number) => ({
    ...threadDetailBody(
      thread,
      [
        {
          id: "turn-1",
          status: "completed",
          startedAt: 1777500001,
          completedAt: 1777500002,
          items: [
            {
              id: "user-1",
              itemType: "userMessage",
              rawPayload: { id: "user-1", type: "userMessage", text: "Please inspect files." },
            },
            ...Array.from({ length: fileCount }, (_, index) => fileChangeItem(index)),
            {
              id: "answer-1",
              itemType: "agentMessage",
              rawPayload: { id: "answer-1", type: "agentMessage", text: "Finished changing files.", phase: "final_answer" },
            },
          ],
          rawPayload: {},
        },
        {
          id: "turn-2",
          status: "completed",
          startedAt: 1777500003,
          completedAt: 1777500004,
          items: [
            {
              id: "user-2",
              itemType: "userMessage",
              rawPayload: { id: "user-2", type: "userMessage", text: skillText },
              skillMentions: [skillMention],
            },
          ],
          rawPayload: {},
        },
      ],
      "idle",
    ),
    timeline: {
      activeTurnId: null,
      liveState: "idle",
      rows: canonicalRowsFromSnapshotItems(timelineItems(fileCount)),
      items: timelineItems(fileCount),
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      turns: [
        { id: "turn-1", status: "completed", startedAt: 1777500001, completedAt: 1777500002 },
        { id: "turn-2", status: "completed", startedAt: 1777500003, completedAt: 1777500004 },
      ],
      viewRevision: 1,
    },
  });
  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      const event = {
        id: "event-file-growth",
        seq: 2,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        itemId: null,
        projectId: null,
        threadId: thread.id,
        turnId: null,
        payload: {
          activeTurnId: null,
          rows: canonicalRowsFromSnapshotItems(timelineItems(23)),
          items: timelineItems(23),
          liveState: "idle",
          pendingApprovalRequests: [],
          pendingUserInputRequests: [],
          threadId: thread.id,
          turns: [
            { id: "turn-1", status: "completed", startedAt: 1777500001, completedAt: 1777500002 },
            { id: "turn-2", status: "completed", startedAt: 1777500003, completedAt: 1777500004 },
          ],
          viewRevision: 2,
        },
        receivedAt: "2026-04-30T00:00:03Z",
      };
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: `event: thread_view.patch\ndata: ${JSON.stringify(event)}\n\n`,
      });
      return;
    }

    const response =
      key === "GET /v1/threads/thread-1"
        ? { body: threadBody(23) }
        : key === "GET /v1/approvals"
          ? { body: { approvals: [] } }
          : await responseFor(key, route);

    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await page.setViewportSize({ width: 820, height: 760 });
  await page.goto("/threads/thread-1");

  await expect(page.getByLabel("Implement Review Loop skill")).toBeVisible();
  await expect(page.getByText("23 files changed")).toBeVisible();
  await expect(page.getByLabel("Implement Review Loop skill")).toBeVisible();
  await expectNoRenderedTimelineOverlap(page);

  await page.getByText("Modified").first().click();
  await expect(page.getByLabel(/file diff for src\/generated-/i).first()).toBeVisible();
  await expect(page.getByLabel("Implement Review Loop skill")).toBeVisible();
  await expectNoRenderedTimelineOverlap(page);
});

test("lets thread titles use the expanded sidebar width before truncating", async ({ page }) => {
  const longTitle = "Investigate sidebar title truncation with enough words to fill the expanded workspace panel";
  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
      return;
    }

    const response =
      key === "GET /v1/threads"
        ? {
            body: {
              threads: [{ ...thread, name: longTitle, status: "idle" }],
              nextCursor: null,
              backwardsCursor: null,
              rawPayload: {},
            },
          }
        : key === "GET /v1/threads/thread-1"
          ? {
              body: threadDetailBody({ ...thread, name: longTitle, status: "idle" }),
            }
        : key === "GET /v1/approvals"
          ? { body: { approvals: [] } }
        : await responseFor(key, route);

    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await page.goto("/threads/thread-1");

  const resizeHandle = page.getByRole("separator", { name: /resize workspace sidebar/i });
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await resizeHandle.dragTo(resizeHandle, {
    force: true,
    sourcePosition: { x: 0, y: handleBox!.height / 2 },
    targetPosition: { x: 260, y: handleBox!.height / 2 },
  });

  const threadButton = page.locator(".kodex-thread-list-button").first();
  await expect(threadButton).toBeVisible();
  await threadButton.hover();

  const metrics = await threadButton.evaluate((button) => {
    const titleNode = button.querySelector(".kodex-thread-list-title");
    const actionSlot = button.querySelector(".kodex-sidebar-row-trailing");
    if (!titleNode) {
      throw new Error("Missing thread title node");
    }
    if (!actionSlot) {
      throw new Error("Missing thread action slot");
    }
    const buttonRect = button.getBoundingClientRect();
    const titleRect = titleNode.getBoundingClientRect();
    const actionRect = actionSlot.getBoundingClientRect();
    return {
      actionLeft: actionRect.left,
      actionWidth: actionRect.width,
      buttonRight: buttonRect.right,
      text: titleNode.textContent,
      titleRight: titleRect.right,
    };
  });

  expect(metrics.text).toBe(longTitle);
  expect(metrics.titleRight).toBeLessThanOrEqual(metrics.actionLeft);
  expect(metrics.actionWidth).toBeGreaterThanOrEqual(18);
  expect(metrics.buttonRight - metrics.titleRight).toBeLessThanOrEqual(48);
});

test("resolves a pending approval", async ({ page }) => {
  let approvalPending = true;
  await page.unroute("**/v1/**");
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "",
      });
      return;
    }

    if (key === "GET /v1/approvals") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvals: approvalPending ? [approval] : [] }),
      });
      return;
    }

    if (key === "POST /v1/approvals/approval-1/decision") {
      approvalPending = false;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...approval, status: "resolved", response: { decision: "accept" } }),
      });
      return;
    }

    const response = await responseFor(key, route);
    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await page.goto("/threads/thread-1");

  const threadCard = page.getByRole("button", { name: /frontend mvp/i });
  await expect(threadCard.getByText(/needs approval/i)).toBeVisible();

  const thread = page.getByRole("main", { name: /thread/i });
  await expect(thread.getByText(/cargo test/i)).toBeVisible();
  await thread.getByRole("button", { name: /yes, proceed/i }).first().click();
  await expect(thread.getByText(/cargo test/i)).toBeHidden();
  await expect(threadCard.getByText(/needs approval/i)).toBeHidden();
});

test("opens preferences from the settings menu and switches between dark and light schemes", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /account settings/i }).click();
  await page.getByRole("menuitem", { name: /preferences/i }).click();

  const dialog = page.getByRole("dialog", { name: /preferences/i });
  await expect(dialog).toBeVisible();

  const dracula = dialog.getByRole("radio", { name: /dracula/i });
  await dracula.click();
  await expect(dracula).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");

  const paperLight = dialog.getByRole("radio", { name: /paper light/i });
  await paperLight.click();
  await expect(paperLight).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", "paper-light");
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
});

test("restores selected thread model settings when switching threads", async ({ page }) => {
  await page.unroute("**/v1/**");

  const threadsById: Record<string, { id: string; name: string; model: string }> = {};
  const miniThreadId = "thread-mini";
  const sparkThreadId = "thread-spark";
  let createCount = 0;

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const key = `${method} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "",
      });
      return;
    }

    if (key === "GET /v1/events") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
      return;
    }

    if (key === "GET /v1/capabilities") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: {
            version: "0.1.0",
            sse: true,
            approvals: true,
            gatewayAuth: false,
            trustedNetworkOnly: true,
          },
          appServer: { ready: true, experimentalApi: true },
        }),
      });
      return;
    }

    if (key === "GET /v1/projects") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projects: [{ id: "project-1", name: "Kodex", cwd: "/tmp", createdAt: "2026-05-05T00:00:00Z", updatedAt: "2026-05-05T00:00:00Z" }],
        }),
      });
      return;
    }

    if (key === "GET /v1/account") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiresOpenaiAuth: true, account: null, rawPayload: {} }),
      });
      return;
    }

    if (key === "GET /v1/account/rate-limits") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} }),
      });
      return;
    }

    if (key === "GET /v1/models") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: [
            {
              id: "gpt-5.4mini",
              model: "gpt-5.4mini",
              displayName: "GPT-5.4 Mini",
              description: "Fast coding model",
              defaultReasoningEffort: "medium",
              hidden: false,
              inputModalities: ["text"],
              isDefault: true,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              upgrade: null,
            },
            {
              id: "gpt-5.3spark",
              model: "gpt-5.3spark",
              displayName: "GPT-5.3 Spark",
              description: "Balanced coding model",
              defaultReasoningEffort: "medium",
              hidden: false,
              inputModalities: ["text"],
              isDefault: false,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              upgrade: null,
            },
          ],
          nextCursor: null,
          rawPayload: {},
        }),
      });
      return;
    }

    if (key === "GET /v1/composer-settings") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null, effort: null, serviceTier: null, permissionsPreset: null }),
      });
      return;
    }

    if (key === "GET /v1/threads") {
      const threads = Object.values(threadsById).map((thread) => ({
        id: thread.id,
        name: thread.name,
        cwd: "/tmp",
        status: "idle",
        source: "local",
        preview: `Thread ${thread.name}`,
        lastCompletedAgentTurnSeq: null,
        seenCompletedAgentTurnSeq: 0,
        unreadCompletedAgentTurn: false,
        rawPayload: { model: thread.model, reasoningEffort: null, serviceTier: null },
        createdAt: 1777500000,
        updatedAt: 1777501000,
      }));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads, nextCursor: null, backwardsCursor: null, rawPayload: {} }),
      });
      return;
    }

    if (key === "GET /v1/chats/threads" || key === "GET /v1/threads/pinned") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} }),
      });
      return;
    }

    if (key === "GET /v1/approvals") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvals: [] }),
      });
      return;
    }

    if (key.startsWith("GET /v1/threads/") && !key.endsWith("/resume") && !key.endsWith("/queued-inputs")) {
      const threadId = url.pathname.split("/").at(-1);
      const thread = threadId ? threadsById[threadId] : null;
      if (!thread) {
        await route.fulfill({ status: 404, headers: { "Content-Type": "application/json" }, body: "{}" });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(threadDetailBody({
            id: thread.id,
            name: thread.name,
            cwd: "/tmp",
            status: "idle",
            source: "local",
            preview: `Thread ${thread.name}`,
            lastCompletedAgentTurnSeq: null,
            seenCompletedAgentTurnSeq: 0,
            unreadCompletedAgentTurn: false,
            rawPayload: { model: thread.model },
            createdAt: 1777500000,
            updatedAt: 1777501000,
          })),
      });
      return;
    }

    if (key === "POST /v1/chats/threads") {
      const nextName = createCount === 0 ? "mini" : "spark";
      const threadId = createCount === 0 ? miniThreadId : sparkThreadId;
      const model = createCount === 0 ? "gpt-5.4mini" : "gpt-5.3spark";
      createCount += 1;
      const modelEffort = "medium";
      threadsById[threadId] = { id: threadId, name: nextName, model };
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread: {
            id: threadId,
            name: nextName,
            model,
            reasoningEffort: modelEffort,
            cwd: "/tmp",
            status: "idle",
            source: "local",
            preview: `Thread ${nextName}`,
            lastCompletedAgentTurnSeq: null,
            seenCompletedAgentTurnSeq: 0,
            unreadCompletedAgentTurn: false,
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501000,
          },
          rawPayload: {},
        }),
      });
      return;
    }

    if (key.startsWith("POST /v1/threads/") && key.endsWith("/attach")) {
      const threadId = url.pathname.split("/").at(-2);
      const thread = threadId ? threadsById[threadId] : null;
      if (!thread) {
        await route.fulfill({ status: 404, headers: { "Content-Type": "application/json" }, body: "{}" });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disposition: "resumed",
          thread: {
            id: thread.id,
            name: thread.name,
            cwd: "/tmp",
            status: "idle",
            source: "local",
            preview: `Thread ${thread.name}`,
            lastCompletedAgentTurnSeq: null,
            seenCompletedAgentTurnSeq: 0,
            unreadCompletedAgentTurn: false,
            rawPayload: { model: thread.model },
            createdAt: 1777500000,
            updatedAt: 1777501000,
          },
          rawPayload: {},
        }),
      });
      return;
    }

    if (key.startsWith("POST /v1/threads/") && key.endsWith("/input")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: "started", queuedInput: null, rawPayload: {} }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "not_found", message: key, retryable: false }),
    });
  });

  await page.goto("/");

  await page.getByRole("button", { name: /start new chat from desktop header/i }).click();
  await composerInActiveThreadPane(page).fill("mini thread message");
  await sendButtonInActiveThreadPane(page).click();
  await expect(modelButtonInActiveThreadPane(page, /model: gpt-5\.4mini/i)).toBeVisible();

  await page.getByRole("button", { name: /start new chat from desktop header/i }).click();
  await selectModelInActiveThreadPane(page, "gpt-5.3spark");
  await expect(modelButtonInActiveThreadPane(page, /model: gpt-5\.3spark/i)).toBeVisible();
  await composerInActiveThreadPane(page).fill("spark thread message");
  await sendButtonInActiveThreadPane(page).click();
  await expect(modelButtonInActiveThreadPane(page, /model: gpt-5\.3spark/i)).toBeVisible();

  await page.getByRole("button", { name: "mini", exact: true }).click();
  await expect(modelButtonInActiveThreadPane(page, /model: gpt-5\.4mini/i)).toBeVisible();
});

test("composer fast toggle clears fast service tier for next send", async ({ page }) => {
  await page.unroute("**/v1/**");
  const fastThread = {
    ...thread,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    serviceTier: "fast",
    rawPayload: { model: "gpt-5.4", reasoningEffort: "medium", serviceTier: "fast" },
  };
  let submittedBody: Record<string, unknown> | null = null;

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
      return;
    }
    if (key === "GET /v1/threads") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: [fastThread], nextCursor: null, backwardsCursor: null, rawPayload: {} }),
      });
      return;
    }
    if (key === "GET /v1/threads/thread-1") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(threadDetailBody(fastThread)),
      });
      return;
    }
    if (key === "GET /v1/composer-settings") {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null, effort: null, serviceTier: null, permissionsPreset: null }),
      });
      return;
    }
    if (key === "POST /v1/threads/thread-1/input") {
      submittedBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: "started", queuedInput: null, rawPayload: {} }),
      });
      return;
    }

    const response = await responseFor(key, route);
    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });

  await openFrontendMvpThread(page);
  await expect(page.getByRole("img", { name: /fast responses enabled/i })).toBeVisible();

  await modelButtonInActiveThreadPane(page, /model: gpt-5\.4, medium/i).click();
  const fastRow = page.getByRole("menuitemcheckbox", { name: /fast/i });
  await expect(fastRow).toHaveAttribute("aria-checked", "true");
  const fastRowBox = await fastRow.boundingBox();
  if (!fastRowBox) {
    throw new Error("Fast menu row was not visible");
  }
  await page.mouse.click(fastRowBox.x + fastRowBox.width - 18, fastRowBox.y + fastRowBox.height / 2);
  await expect(page.getByRole("img", { name: /fast responses enabled/i })).toBeHidden();

  await composerInActiveThreadPane(page).fill("Use normal speed");
  await sendButtonInActiveThreadPane(page).click();

  await expect.poll(() => submittedBody?.serviceTier).toBe(null);
  expect(submittedBody).toMatchObject({
    input: [{ type: "text", text: "Use normal speed" }],
    model: "gpt-5.4",
    effort: "medium",
  });
});

async function expectNoRenderedTimelineOverlap(page: Page) {
  const boxes = await page.locator(".kodex-timeline-virtual-row").evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          height: rect.height,
          text: node.textContent ?? "",
          top: rect.top,
        };
      })
      .filter((box) => box.height > 0)
      .sort((left, right) => left.top - right.top),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (let index = 1; index < boxes.length; index += 1) {
    expect
      .soft(
        boxes[index].top,
        `timeline row overlapped previous row: ${boxes[index - 1].text.slice(0, 40)} -> ${boxes[index].text.slice(0, 40)}`,
      )
      .toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
  }
}

async function mockGateway(page: Page) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "",
      });
      return;
    }

    const response = await responseFor(key, route);
    await route.fulfill({
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.body),
    });
  });
}

async function responseFor(key: string, route: Route): Promise<{ status?: number; body: unknown }> {
  if (key === "GET /v1/capabilities") {
    return {
      body: {
        gateway: {
          version: "0.1.0",
          sse: true,
          approvals: true,
          gatewayAuth: false,
          trustedNetworkOnly: true,
        },
        appServer: { ready: true, experimentalApi: true },
      },
    };
  }
  if (key === "GET /v1/projects") {
    return { body: { projects: [project] } };
  }
  if (key === "POST /v1/projects") {
    const body = route.request().postDataJSON() as { cwd: string; name?: string | null };
    return {
      status: 201,
      body: {
        id: "project-2",
        name: body.name ?? "Scratch",
        cwd: body.cwd,
        createdAt: "2026-04-30T00:00:00Z",
        updatedAt: "2026-04-30T00:00:00Z",
      },
    };
  }
  if (key === "GET /v1/threads") {
    return { body: { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} } };
  }
  if (key === "GET /v1/threads/thread-1") {
    return {
      body: threadDetailBody(
        { ...thread, lastCompletedAgentTurnSeq: 1, seenCompletedAgentTurnSeq: 1, unreadCompletedAgentTurn: false },
        [
          {
            id: "turn-1",
            status: "completed",
            startedAt: 1777500001,
            completedAt: 1777500002,
            items: [
              {
                id: "item-stream",
                itemType: "agentMessage",
                rawPayload: { id: "item-stream", type: "agentMessage", text: "Snapshot assistant output" },
              },
            ],
            rawPayload: {},
          },
        ],
      ),
    };
  }
  if (key === "GET /v1/threads/thread-1/app-surface") {
    return { body: { session: null } };
  }
  if (key === "POST /v1/threads") {
    return {
      body: {
        thread: { ...thread, id: "thread-2", name: "New thread", status: "idle" },
        rawPayload: {},
      },
    };
  }
  if (key === "GET /v1/events") {
    return { body: { events: [] } };
  }
  if (key === "GET /v1/approvals") {
    return { body: { approvals: [] } };
  }
  if (key === "POST /v1/approvals/approval-1/decision") {
    return { body: { ...approval, status: "resolved", response: { decision: "accept" } } };
  }
  if (
    key === "POST /v1/threads/thread-2/input" ||
    key === "POST /v1/threads/thread-2/turns" ||
    key === "POST /v1/threads/thread-1/input" ||
    key === "POST /v1/threads/thread-1/turns"
  ) {
    return { body: { payload: {} } };
  }
  if (key === "POST /v1/threads/thread-1/seen") {
    return {
      body: {
        threadId: "thread-1",
        seenCompletedAgentTurnSeq: 1,
        updatedAt: "2026-04-30T00:00:02Z",
      },
    };
  }
  if (key === "GET /v1/account") {
    return { body: { requiresOpenaiAuth: true, account: null, rawPayload: {} } };
  }
  if (key === "GET /v1/account/rate-limits") {
    return { body: { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} } };
  }
  if (key === "GET /v1/models") {
    return {
      body: {
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "General coding model",
            defaultReasoningEffort: "medium",
            hidden: false,
            inputModalities: ["text"],
            isDefault: true,
            rawPayload: {},
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
            upgrade: null,
          },
        ],
        nextCursor: null,
        rawPayload: {},
      },
    };
  }

  return { status: 404, body: { code: "not_found", message: key, retryable: false } };
}

function sse(event: { kind: string }) {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}
