import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VirtuosoMockContext } from "react-virtuoso";
import { expect, vi } from "vitest";

import { App as KodexApp } from "../App";
import type { GatewayRouteMap } from "./gatewayMock";
import { mockGateway, requestJson } from "./gatewayMock";

function App() {
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
      <KodexApp />
    </VirtuosoMockContext.Provider>
  );
}

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
    terminals: { enabled: true },
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
  notificationsEnabled: true,
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
    "GET /v1/permission-profiles": {
      profiles: [
        { id: ":workspace", label: "Default permissions", description: "Ask before sandbox escapes and write inside the workspace." },
        { id: "auto-review", label: "Auto review", description: "Route approval decisions through the auto reviewer." },
        { id: "full-access", label: "Full access", description: "Runs without sandbox restrictions on this local machine." },
      ],
    },
    "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionProfileId: null, permissionsPreset: null },
    ...overrides,
  };
  routes["GET /v1/sidebar/threads"] ??= canBuildStaticSidebarThreadsSnapshot(routes)
    ? () => sidebarThreadsFromRoutes(routes)
    : missingSidebarThreadsRoute;
  routes["POST /v1/threads/thread-1/attach"] ??= () => ({ disposition: "resumed", ...threadCommandFromList(routes, thread) });
  routes["POST /v1/threads/thread-2/attach"] ??= () => ({ disposition: "resumed", ...threadCommandFromList(routes, secondThread) });
  routes["POST /v1/threads/thread-1/resume"] ??= () => threadCommandFromList(routes, thread);
  routes["POST /v1/threads/thread-2/resume"] ??= () => threadCommandFromList(routes, secondThread);
  routes["GET /v1/threads/thread-1/queued-inputs"] ??= { queuedInputs: [] };
  routes["GET /v1/threads/thread-2/queued-inputs"] ??= { queuedInputs: [] };
  routes["GET /v1/threads/thread-1/app-surface"] ??= { session: null };
  routes["GET /v1/threads/thread-2/app-surface"] ??= { session: null };
  routes["POST /v1/threads/thread-1/queued-inputs"] ??= (request: Request) => {
    nextQueueIndex += 1;
    return queuedInputFromRequest(request, "thread-1", `queue-${nextQueueIndex}`);
  };
  routes["POST /v1/threads/thread-1/input"] ??= {
    disposition: "steered",
    queuedInput: null,
    rawPayload: { turnId: "turn-active" },
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

function canBuildStaticSidebarThreadsSnapshot(routes: GatewayRouteMap): boolean {
  return [
    routes["GET /v1/projects"],
    routes["GET /v1/threads"],
    routes["GET /v1/chats/threads"],
    routes["GET /v1/threads/pinned"],
  ].every((route) => route !== undefined && typeof route !== "function");
}

function missingSidebarThreadsRoute() {
  return new Response(JSON.stringify({ code: "not_found", message: "Unhandled route", retryable: false }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function sidebarThreadsFromRoutes(routes: GatewayRouteMap) {
  const projectsResponse = staticRouteValue<{ projects: typeof project[] }>(routes["GET /v1/projects"]) ?? { projects: [project] };
  const projectThreads = Object.fromEntries(
    projectsResponse.projects.map((item) => {
      const projectThreadsResponse =
        staticRouteValue<{ threads: typeof thread[]; nextCursor: string | null; backwardsCursor: string | null; rawPayload: unknown }>(
          routes["GET /v1/threads"],
        ) ?? { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} };
      return [item.id, projectThreadsResponse];
    }),
  );
  return {
    projects: projectsResponse.projects,
    projectThreads,
    chatThreads:
      staticRouteValue(routes["GET /v1/chats/threads"]) ?? { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    pinnedThreads:
      staticRouteValue(routes["GET /v1/threads/pinned"]) ?? { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
  };
}

function staticRouteValue<T>(route: GatewayRouteMap[string] | undefined): T | null {
  return typeof route === "function" || route === undefined ? null : (route as T);
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
  const items = turns.flatMap((turn) =>
    turn.items.map((item) => {
      const snapshot = item as { id?: string; itemType?: string; rawPayload?: unknown };
      displayOrder += 1;
      return {
        id: `projection-${turn.id}-${snapshot.id ?? displayOrder}`,
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
  );
  return {
    viewRevision: 1,
    activeTurnId: activeTurn?.id ?? null,
    liveState: sourceThread.status === "active" ? "streaming" : "idle",
    rows: canonicalRowsFromSnapshotItems(items),
    items,
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
  skillMentions,
  imagePath,
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
  skillMentions?: unknown[];
  imagePath?: string;
}) {
  const userContent = [
    ...(imagePath ? [{ type: "localImage", path: imagePath }] : []),
    { type: "text", text },
  ];
  const item = {
    id: `projection-${turnId}-${itemId}`,
    threadId,
    turnId,
    itemId,
    itemType,
    displayOrder,
    status,
    timestampMs: displayOrder,
    codexMethod: status === "completed" ? "item/completed" : "item/upsert",
    payload: {
      source: "gatewayStream",
      turnId,
      itemId,
      item: itemType === "userMessage"
        ? { id: itemId, type: "userMessage", content: userContent }
        : { id: itemId, type: "agentMessage", text },
      itemSnapshot: {
        id: itemId,
        itemType,
        ...(skillMentions ? { skillMentions } : {}),
        rawPayload: itemType === "userMessage"
          ? { id: itemId, type: "userMessage", content: userContent }
          : { id: itemId, type: "agentMessage", text },
      },
    },
  };
  return {
    id,
    seq,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    projectId,
    threadId,
    turnId,
    itemId: null,
    payload: {
      scope: "turn",
      viewRevision: seq,
      threadId,
      activeTurnId: turnId,
      liveState: "streaming",
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      affectedTurnIds: [turnId],
      rows: canonicalRowsFromSnapshotItems([item]),
      turns: [{ id: turnId, status }],
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
  canonicalRowsFromSnapshotItems,
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
