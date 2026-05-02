import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, vi } from "vitest";

import { App } from "../App";
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
}

function baseRoutes(overrides = {}) {
  return {
    "GET /v1/capabilities": capabilities,
    "GET /v1/projects": { projects: [project] },
    "GET /v1/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/events": {
      events: [
        {
          id: "event-1",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: thread.id,
          turnId: "turn-1",
          itemId: "item-1",
          payload: { delta: "Hello from Codex" },
          receivedAt: "2026-04-30T00:00:00Z",
        },
      ],
    },
    "GET /v1/approvals": { approvals: [] },
    "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
    "GET /v1/models": { models: [model], nextCursor: null, rawPayload: {} },
    "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionsPreset: null },
    ...overrides,
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
  requestJson,
  secondThread,
  thread,
  timelineElement,
};
