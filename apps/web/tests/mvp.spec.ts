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
  status: "active",
  source: "local",
  preview: "Build the web client",
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

test.beforeEach(async ({ page }) => {
  await mockGateway(page);
});

test("creates and selects a project", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: /kodex \/home\/example\/kodex/i })).toBeVisible();
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByLabel(/project name/i).fill("Scratch");
  await page.getByLabel(/working directory/i).fill("/tmp/scratch");
  await page.getByRole("button", { name: /create project/i }).click();

  await expect(page.getByRole("button", { name: /scratch \/tmp\/scratch/i })).toBeVisible();
});

test("creates a thread and submits a turn", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /new thread/i }).click();
  await expect(page.getByRole("heading", { name: /new thread/i })).toBeVisible();

  await page.getByLabel(/message composer/i).fill("Implement the next milestone");
  await page.getByRole("button", { name: /send message/i }).click();
  await expect(page.getByLabel(/message composer/i)).toBeEmpty();
});

test("renders streamed assistant output", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText(/streamed assistant output/i)).toBeVisible();
});

test("keeps long timeline content inside the thread viewer", async ({ page }) => {
  const longWord = "supercalifragilistic".repeat(24);
  const longCommand = `node -e "console.log('${"wide-output".repeat(20)}')"`;
  const longOutput = "0123456789abcdef".repeat(80);
  await page.route("**/v1/events**", async (route) => {
    const request = route.request();
    if (request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            id: "event-assistant-long",
            seq: 1,
            kind: "codex.notification",
            codexMethod: "item/completed",
            projectId: project.id,
            threadId: thread.id,
            turnId: "turn-1",
            itemId: "assistant-long",
            payload: { item: { id: "assistant-long", type: "agentMessage", text: longWord } },
            receivedAt: "2026-04-30T00:00:00Z",
          },
          {
            id: "event-command-long",
            seq: 2,
            kind: "codex.notification",
            codexMethod: "item/completed",
            projectId: project.id,
            threadId: thread.id,
            turnId: "turn-1",
            itemId: "command-long",
            payload: {
              item: {
                id: "command-long",
                type: "commandExecution",
                command: longCommand,
                output: `${longOutput}\n`,
              },
            },
            receivedAt: "2026-04-30T00:00:01Z",
          },
        ],
      }),
    });
  });

  await page.setViewportSize({ width: 720, height: 760 });
  await page.goto("/");
  await expect(page.getByText(longWord)).toBeVisible();

  const viewer = page.locator(".kodex-timeline-scroll");
  const cards = page.locator(".kodex-turn-group, .kodex-timeline-item, .kodex-activity-group");
  const viewerBox = await viewer.boundingBox();
  expect(viewerBox).not.toBeNull();
  const cardBoxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.max(...cardBoxes)).toBeLessThanOrEqual(Math.ceil(viewerBox!.width));

  const commandSummary = page.locator(".kodex-activity-title").filter({ hasText: /^Ran / }).first();
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

test("resolves a pending approval", async ({ page }) => {
  await page.goto("/");

  const approvals = page.getByRole("complementary", { name: /approvals/i });
  await expect(approvals.getByText(/cargo test/i)).toBeVisible();
  await approvals.getByRole("button", { name: /accept approval/i }).first().click();
  await expect(approvals.getByText(/cargo test/i)).toBeHidden();
});

async function mockGateway(page: Page) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (key === "GET /v1/events" && request.headers().accept?.includes("text/event-stream")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sse({
          id: "event-2",
          seq: Number(url.searchParams.get("cursor") ?? "1") + 1,
          kind: "codex.notification",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: thread.id,
          turnId: "turn-1",
          itemId: "item-stream",
          payload: { delta: "Streamed assistant output" },
          receivedAt: "2026-04-30T00:00:01Z",
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
    return { body: { approvals: [approval] } };
  }
  if (key === "POST /v1/approvals/approval-1/decision") {
    return { body: { ...approval, status: "resolved", response: { decision: "accept" } } };
  }
  if (key === "POST /v1/threads/thread-2/turns" || key === "POST /v1/threads/thread-1/turns") {
    return { body: { payload: {} } };
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
