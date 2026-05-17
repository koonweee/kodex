import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, vi } from "vitest";

import { App } from "../App";
import type { GatewayRouteMap } from "./gatewayMock";
import { mockGateway, requestJson } from "./gatewayMock";

function readCssImportGraph(filePath: string, seen = new Set<string>()): string {
  const resolvedPath = resolve(filePath);
  if (seen.has(resolvedPath)) {
    return "";
  }
  seen.add(resolvedPath);

  const css = readFileSync(resolvedPath, "utf8");
  return css.replace(/@import\s+["']([^"']+)["'];/g, (_match, importPath: string) =>
    readCssImportGraph(resolve(dirname(resolvedPath), importPath), seen),
  );
}

const appCss = readCssImportGraph(join(process.cwd(), "src/App.css"));

const capabilities = {
  gateway: {
    version: "0.1.0",
    sse: true,
    approvals: true,
    gatewayAuth: false,
    trustedNetworkOnly: true,
  },
  appServer: {
    ready: true,
    experimentalApi: true,
  },
};

const project = {
  id: "project-1",
  name: "Kodex",
  cwd: "/home/example/kodex",
  createdAt: "2026-04-30T00:00:00Z",
  updatedAt: "2026-04-30T00:00:00Z",
};

const thread = {
  id: "thread-1",
  name: "Implement frontend",
  cwd: "/home/example/kodex",
  status: "idle",
  source: "local",
  preview: "Scaffold the web client",
  rawPayload: {},
  createdAt: 1777500000,
  updatedAt: 1777501200,
};

const activeThread = { ...thread, status: "active" };
const secondThread = {
  ...thread,
  id: "thread-2",
  name: "Second thread",
  preview: "A second thread",
};

const model = {
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
};

const highReasoningModel = {
  ...model,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper reasoning" },
  ],
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emitNamed(type: string, payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }
}

function baseRoutes(overrides: GatewayRouteMap = {}): GatewayRouteMap {
  let nextQueueIndex = 0;
  const routes: GatewayRouteMap = {
    "GET /v1/capabilities": capabilities,
    "GET /v1/projects": { projects: [project] },
    "GET /v1/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/chats/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/threads/pinned": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/events": { events: [] },
    "GET /v1/approvals": { approvals: [] },
    "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
    "GET /v1/models": { models: [model], nextCursor: null, rawPayload: {} },
    "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionsPreset: null },
    ...overrides,
  };
  routes["POST /v1/threads/thread-1/resume"] ??= () => threadCommandFromList(routes, thread);
  routes["POST /v1/threads/thread-2/resume"] ??= () => threadCommandFromList(routes, secondThread);
  routes["GET /v1/threads/thread-1/queued-inputs"] ??= { queuedInputs: [] };
  routes["GET /v1/threads/thread-2/queued-inputs"] ??= { queuedInputs: [] };
  routes["POST /v1/threads/thread-1/queued-inputs"] ??= (request: Request) => {
    nextQueueIndex += 1;
    return queuedInputFromRequest(request, "thread-1", `queue-${nextQueueIndex}`);
  };
  routes["POST /v1/threads/thread-1/queued-inputs/queue-1/retry"] ??= {
    queuedInput: queuedInput("queue-1", "thread-1", "Retry later", "queued"),
  };
  routes["POST /v1/threads/thread-1/queued-inputs/queue-1/steer"] ??= {
    queuedInput: queuedInput("queue-1", "thread-1", "Add tests", "pendingCommit"),
  };
  routes["DELETE /v1/threads/thread-1/queued-inputs/queue-1"] ??= { id: "queue-1", threadId: "thread-1" };
  routes["GET /v1/threads/thread-1"] ??= (request: Request) =>
    threadDetailFromSnapshot(routes, request, thread, [
      snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Hello from Codex" })]),
    ]);
  routes["GET /v1/threads/thread-2"] ??= (request: Request) =>
    threadDetailFromSnapshot(routes, request, secondThread);
  return routes;
}

type TestThreadSummary = Omit<typeof thread, "name"> & { name: string | null } & Record<string, unknown>;
type TestSnapshotTurn = { id: string; status: string; items: unknown[]; rawPayload?: unknown };

async function threadDetailFromSnapshot(
  routes: GatewayRouteMap,
  _request: Request,
  sourceThread: TestThreadSummary,
  turns = [] as TestSnapshotTurn[],
) {
  sourceThread = await listedThreadFor(routes, sourceThread);
  if (sourceThread.status === "active") {
    const activeTurn = [...turns].reverse().find((turn) => turn.items.length > 0);
    if (activeTurn) {
      activeTurn.status = "running";
    }
  }
  return {
    thread: sourceThread,
    turns,
    liveState: sourceThread.status === "active" ? "streaming" : "idle",
    timeline: timelineFromTurns(sourceThread, turns),
    rawPayload: {},
  };
}

async function threadCommandFromList(routes: GatewayRouteMap, sourceThread: TestThreadSummary) {
  return {
    thread: await listedThreadFor(routes, sourceThread),
    rawPayload: {},
  };
}

async function listedThreadFor(routes: GatewayRouteMap, sourceThread: TestThreadSummary) {
  const threadsRoute = routes["GET /v1/threads"];
  const threadsBody =
    typeof threadsRoute === "function"
      ? await threadsRoute(new Request("http://localhost/v1/threads"))
      : threadsRoute;
  const listedThread = (threadsBody as { threads?: Array<typeof thread> } | undefined)?.threads?.find(
    (candidate) => candidate.id === sourceThread.id,
  );
  return listedThread ?? sourceThread;
}

function snapshotTurn(id: string, items: unknown[], status = "completed") {
  return { id, status, items, rawPayload: { id, status: { type: status }, items } };
}

function snapshotItem(id: string, itemType: string, payload: Record<string, unknown>) {
  return {
    id,
    itemType,
    rawPayload: { id, type: itemType, ...payload },
  };
}

function threadDetail(sourceThread: TestThreadSummary, turns: ReturnType<typeof snapshotTurn>[] = []) {
  return {
    thread: sourceThread,
    turns,
    liveState: sourceThread.status === "active" ? "streaming" : "idle",
    timeline: timelineFromTurns(sourceThread, turns),
    rawPayload: {},
  };
}

function timelineFromTurns(sourceThread: TestThreadSummary, turns: TestSnapshotTurn[]) {
  let displayOrder = 0;
  const activeTurn = [...turns].reverse().find((turn) => !["completed", "failed", "cancelled"].includes(turn.status));
  return {
    revision: 1,
    activeTurnId: activeTurn?.id ?? null,
    liveState: sourceThread.status === "active" ? "streaming" : "idle",
    items: turns.flatMap((turn) =>
      turn.items.map((item) => {
        const snapshot = item as { id?: string; itemType?: string; rawPayload?: unknown };
        displayOrder += 1;
        return {
          id: `snapshot-${turn.id}-${snapshot.id ?? displayOrder}`,
          threadId: sourceThread.id,
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
    ),
  };
}

function projectionPatchEvent({
  id = "projection-patch-1",
  seq = 2,
  projectId = project.id,
  threadId = thread.id,
  turnId = "turn-live",
  itemId = "agent-live",
  itemType = "agentMessage",
  text = "Live update",
  displayOrder = seq,
  status = "running",
}: {
  id?: string;
  seq?: number;
  projectId?: string | null;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  text?: string;
  displayOrder?: number;
  status?: string;
}) {
  return {
    id,
    seq,
    kind: "timeline.projection_patch",
    codexMethod: "timeline/projection_patch",
    projectId,
    threadId,
    turnId,
    itemId: null,
    payload: {
      revision: seq,
      threadId,
      activeTurnId: turnId,
      liveState: "streaming",
      items: [
        {
          id: `projection-${turnId}-${itemId}`,
          threadId,
          turnId,
          itemId,
          itemType,
          displayOrder,
          status,
          timestampMs: displayOrder,
          payload: {
            source: "gatewayStream",
            turnId,
            itemId,
            item: itemType === "userMessage"
              ? { id: itemId, type: "userMessage", content: [{ type: "text", text }] }
              : { id: itemId, type: "agentMessage", text },
            itemSnapshot: {
              id: itemId,
              itemType,
              rawPayload: itemType === "userMessage"
                ? { id: itemId, type: "userMessage", content: [{ type: "text", text }] }
                : { id: itemId, type: "agentMessage", text },
            },
          },
        },
      ],
    },
    receivedAt: "2026-04-30T00:00:02Z",
  };
}

async function queuedInputFromRequest(request: Request, threadId: string, queueId = "queue-1") {
  const body = (await request.json()) as { input?: Array<{ type: string; text?: string }> };
  return {
    queuedInput: {
      id: queueId,
      threadId,
      input: body.input ?? [],
      options: {},
      status: "queued",
      priority: "normal",
      attemptCount: 0,
      lastError: null,
      createdAt: "2026-05-05T00:00:00Z",
      updatedAt: "2026-05-05T00:00:00Z",
    },
  };
}

function queuedInput(id: string, threadId: string, text: string, status = "queued") {
  return {
    id,
    threadId,
    input: [{ type: "text", text }],
    options: {},
    status,
    priority: "normal",
    attemptCount: status === "failed" ? 1 : 0,
    lastError: status === "failed" ? "turn failed" : null,
    createdAt: "2026-05-05T00:00:00Z",
    updatedAt: "2026-05-05T00:00:00Z",
  };
}

function timelineElement(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>(".kodex-timeline-scroll");
  expect(element).not.toBeNull();
  return element!;
}

async function clickMenuItem(name: RegExp, screen: typeof import("@testing-library/react").screen, waitFor: typeof import("@testing-library/react").waitFor, fireEvent: typeof import("@testing-library/react").fireEvent) {
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = screen.queryAllByRole("menuitem", { hidden: true }).find((element) => name.test(element.textContent ?? ""));
    expect(item).toBeInTheDocument();
  });
  expect(item).toBeInTheDocument();
  fireEvent.click(item!);
}

export {
  App,
  FakeEventSource,
  activeThread,
  appCss,
  baseRoutes,
  capabilities,
  clickMenuItem,
  highReasoningModel,
  mockGateway,
  model,
  project,
  projectionPatchEvent,
  requestJson,
  secondThread,
  snapshotItem,
  snapshotTurn,
  thread,
  threadDetail,
  timelineElement,
};
