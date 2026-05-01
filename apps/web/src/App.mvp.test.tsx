import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway, requestJson } from "./test/gatewayMock";

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
    ...overrides,
  };
}

describe("MVP frontend flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("renders projects and threads, creates a project, and starts a thread", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/projects": async (request: Request) => ({
          ...(await requestJson(request)),
          id: "project-2",
          name: "Scratch",
          createdAt: "2026-04-30T00:00:00Z",
          updatedAt: "2026-04-30T00:00:00Z",
        }),
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread" }, rawPayload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /kodex \/home\/example\/kodex/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    await userEvent.type(screen.getByLabelText(/project name/i), "Scratch");
    await userEvent.type(screen.getByLabelText(/working directory/i), "/tmp/scratch");
    await userEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    });
  });

  it("uses preview text as the display title for unnamed threads", async () => {
    const unnamedThread = {
      ...thread,
      id: "019de25f-9ac3-72b1-adf6-a108f82d1fb6",
      name: null,
      preview: "reference the Codex desktop app UI and identify improvements",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [unnamedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /reference the codex desktop app ui/i })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /reference the codex desktop app ui/i })).toBeInTheDocument();
    expect(screen.queryByText("019de25f-9ac3-72b1-adf6-a108f82d1fb6")).not.toBeInTheDocument();
  });

  it("clears the old active thread immediately after creating a project", async () => {
    let resolveNewProjectThreads: (value: unknown) => void = () => undefined;
    const newProjectThreads = new Promise((resolve) => {
      resolveNewProjectThreads = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("projectId") === "project-2"
            ? newProjectThreads
            : { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "POST /v1/projects": async (request: Request) => ({
          ...(await requestJson(request)),
          id: "project-2",
          name: "Scratch",
          createdAt: "2026-04-30T00:00:00Z",
          updatedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    await userEvent.type(screen.getByLabelText(/project name/i), "Scratch");
    await userEvent.type(screen.getByLabelText(/working directory/i), "/tmp/scratch");
    await userEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(1);
    });
    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();
    expect(screen.getByText(/select or create a thread/i)).toBeInTheDocument();

    resolveNewProjectThreads({
      threads: [secondThread],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("selects the first available thread when switching projects", async () => {
    const otherProject = {
      ...project,
      id: "project-2",
      name: "Scratch",
      cwd: "/tmp/scratch",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/projects": { projects: [project, otherProject] },
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("projectId") === "project-2") {
            return {
              threads: [{ ...secondThread, projectId: "project-2" }],
              nextCursor: null,
              backwardsCursor: null,
              rawPayload: {},
            };
          }
          return { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2"
            ? {
                events: [
                  {
                    id: "event-project-2",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: "project-2",
                    threadId: "thread-2",
                    turnId: "turn-2",
                    itemId: "item-2",
                    payload: { delta: "Second project replay" },
                    receivedAt: "2026-04-30T00:00:01Z",
                  },
                ],
              }
            : baseRoutes()["GET /v1/events"];
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /scratch \/tmp\/scratch/i }));

    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
    expect(await screen.findByText(/second project replay/i)).toBeInTheDocument();
  });

  it("clears the old active thread while loading a newly selected project", async () => {
    let resolveSecondThreads: (value: unknown) => void = () => undefined;
    const secondThreads = new Promise((resolve) => {
      resolveSecondThreads = resolve;
    });
    const otherProject = {
      ...project,
      id: "project-2",
      name: "Scratch",
      cwd: "/tmp/scratch",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/projects": { projects: [project, otherProject] },
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("projectId") === "project-2"
            ? secondThreads
            : { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /scratch \/tmp\/scratch/i }));

    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();
    expect(screen.getByText(/select or create a thread/i)).toBeInTheDocument();

    resolveSecondThreads({
      threads: [secondThread],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("replays timeline events and submits turn controls", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/thread-1/turns": { payload: {} },
        "POST /v1/threads/thread-1/turns/turn-1/steer": { payload: {} },
        "POST /v1/threads/thread-1/turns/turn-1/interrupt": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });

    await userEvent.type(screen.getByLabelText(/steer active turn/i), "Add tests");
    await userEvent.click(screen.getByRole("button", { name: /steer turn/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: /stop turn/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/interrupt")).toHaveLength(1);
    });
  });

  it("posts schema-shaped command, file, permission, MCP, and tool-user-input approval responses", async () => {
    const approval = {
      id: "approval-1",
      requestId: "request-1",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify frontend" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const fileApproval = {
      ...approval,
      id: "approval-2",
      method: "item/fileChange/requestApproval",
      payload: { path: "src/App.tsx", reason: "Apply generated patch" },
    };
    const permissionApproval = {
      ...approval,
      id: "approval-3",
      method: "item/permissions/requestApproval",
      payload: {
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    };
    const mcpApproval = {
      ...approval,
      id: "approval-4",
      method: "mcpServer/elicitation/request",
      payload: { message: "Share workspace metadata?" },
    };
    const userInputApproval = {
      ...approval,
      id: "approval-5",
      method: "item/tool/requestUserInput",
      payload: {
        questions: [{ id: "choice", header: "Choice", question: "Pick one" }],
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": {
          approvals: [approval, fileApproval, permissionApproval, mcpApproval, userInputApproval],
        },
        "POST /v1/approvals/approval-1/decision": { ...approval, status: "resolved", response: { decision: "accept" } },
        "POST /v1/approvals/approval-2/decision": {
          ...fileApproval,
          status: "resolved",
          response: { decision: "acceptForSession" },
        },
        "POST /v1/approvals/approval-3/decision": {
          ...permissionApproval,
          status: "resolved",
          response: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
        },
        "POST /v1/approvals/approval-4/decision": {
          ...mcpApproval,
          status: "resolved",
          response: { action: "decline" },
        },
        "POST /v1/approvals/approval-5/decision": {
          ...userInputApproval,
          status: "resolved",
          response: { answers: { choice: { answers: [] } } },
        },
      }),
    );

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(within(approvals).getByText(/cargo test/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/cargo test/i)).toBeInTheDocument();
    expect(within(approvals).getByText(/src\/app\.tsx/i)).toBeInTheDocument();
    expect(within(approvals).getByText(/needs network access/i)).toBeInTheDocument();
    expect(within(approvals).getByText(/share workspace metadata/i)).toBeInTheDocument();
    const permissionCard = within(approvals)
      .getByText(/needs network access/i)
      .closest(".kodex-approval-card") as HTMLElement;
    expect(within(permissionCard).queryByRole("button", { name: /decline approval/i })).not.toBeInTheDocument();
    expect(within(permissionCard).queryByRole("button", { name: /cancel approval/i })).not.toBeInTheDocument();
    await userEvent.click(within(approvals).getAllByRole("button", { name: /accept approval/i })[0]);
    await userEvent.click(within(approvals).getAllByRole("button", { name: /accept for session/i })[0]);
    await userEvent.click(within(approvals).getByRole("button", { name: /grant approval/i }));
    await userEvent.click(within(approvals).getAllByRole("button", { name: /decline approval/i })[0]);
    await userEvent.click(within(approvals).getByRole("button", { name: /submit answers/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")).toHaveLength(1);
      expect(within(approvals).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")[0])).resolves.toEqual({
      decision: { decision: "accept" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")[0])).resolves.toEqual({
      decision: { decision: "acceptForSession" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")[0])).resolves.toEqual({
      decision: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")[0])).resolves.toEqual({
      decision: { action: "decline" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")[0])).resolves.toEqual({
      decision: { answers: { choice: { answers: [] } } },
    });
  });

  it("does not resurrect a locally resolved approval from a stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const approval = {
      id: "approval-local-resolution",
      requestId: "request-local-resolution",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
        "POST /v1/approvals/approval-local-resolution/decision": {
          ...approval,
          status: "resolved",
          response: { decision: "accept" },
          resolvedAt: "2026-04-30T00:00:01Z",
        },
      }),
    );

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    expect(await within(approvals).findByText(/cargo test/i)).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    await userEvent.click(within(approvals).getAllByRole("button", { name: /accept approval/i })[0]);
    await waitFor(() => {
      expect(within(approvals).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    act(() => {
      globalApprovalStream?.emit({
        id: "event-stale-local-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: approval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(approvals).queryByText(/cargo test/i)).not.toBeInTheDocument();
  });

  it("renders command approval actions and posts amendment approval responses", async () => {
    const execPolicyApproval = {
      id: "approval-policy",
      requestId: "request-policy",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: "rg TODO apps/web",
        commandActions: [{ type: "search", command: "rg", path: "apps/web", query: "TODO" }],
        cwd: "/home/example/kodex",
        proposedExecpolicyAmendment: ["allow rg TODO apps/web"],
        reason: "Search source",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const networkPolicyApproval = {
      ...execPolicyApproval,
      id: "approval-network",
      requestId: "request-network",
      payload: {
        command: "curl https://api.example.com",
        commandActions: [{ type: "unknown", command: "curl https://api.example.com" }],
        cwd: "/home/example/kodex",
        proposedNetworkPolicyAmendments: [{ action: "allow", host: "api.example.com" }],
        reason: "Fetch API data",
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [execPolicyApproval, networkPolicyApproval] },
        "POST /v1/approvals/approval-policy/decision": {
          ...execPolicyApproval,
          status: "resolved",
          response: {
            decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } },
          },
        },
        "POST /v1/approvals/approval-network/decision": {
          ...networkPolicyApproval,
          status: "resolved",
          response: {
            decision: {
              applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
            },
          },
        },
      }),
    );

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    expect(await within(approvals).findByText(/search todo in apps\/web/i)).toBeInTheDocument();
    expect(within(approvals).getAllByText(/curl https:\/\/api\.example\.com/i).length).toBeGreaterThan(0);

    await userEvent.click(within(approvals).getByRole("button", { name: /apply exec policy approval/i }));
    await userEvent.click(within(approvals).getByRole("button", { name: /apply allow policy for api\.example\.com/i }));

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-policy/decision")[0])).resolves.toEqual({
      decision: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } } },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-network/decision")[0])).resolves.toEqual({
      decision: {
        decision: {
          applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
        },
      },
    });
  });

  it("applies approval created and resolved events from the stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(baseRoutes());
    const streamedApproval = {
      id: "approval-streamed",
      requestId: "request-streamed",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();
    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await within(approvals).findByText(/npm test/i)).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(within(approvals).queryByText(/npm test/i)).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(1);
  });

  it("keeps the approval drawer in sync for non-selected threads", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());
    const streamedApproval = {
      id: "approval-other-thread",
      requestId: "request-other-thread",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo fmt", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(approvals).findByText(/cargo fmt/i)).toBeInTheDocument();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    await waitFor(() => {
      expect(within(approvals).queryByText(/cargo fmt/i)).not.toBeInTheDocument();
    });
  });

  it("does not drop streamed approvals when the initial pending approval request resolves later", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const streamedApproval = {
      id: "approval-before-load",
      requestId: "request-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm run build", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(approvals).findByText(/npm run build/i)).toBeInTheDocument();

    await act(async () => {
      resolveApprovals({ approvals: [] });
      await Promise.resolve();
    });
    expect(within(approvals).getByText(/npm run build/i)).toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a late stale pending approval response", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const staleApproval = {
      id: "approval-resolved-before-load",
      requestId: "request-resolved-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-resolved",
        seq: 2,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    await act(async () => {
      resolveApprovals({ approvals: [staleApproval] });
      await Promise.resolve();
    });
    expect(within(approvals).queryByText(/npm test/i)).not.toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a later stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());
    const staleApproval = {
      id: "approval-resolved-before-created-replay",
      requestId: "request-resolved-before-created-replay",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo clippy", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const approvals = await screen.findByRole("complementary", { name: /approvals/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-resolved-before-created-replay",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:03Z",
      });
      globalApprovalStream?.emit({
        id: "event-created-after-resolved-replay",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: staleApproval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(approvals).queryByText(/cargo clippy/i)).not.toBeInTheDocument();
  });

  it("ignores stale event replay and streams after switching threads", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveFirstEvents: (value: unknown) => void = () => undefined;
    let resolveSecondEvents: (value: unknown) => void = () => undefined;
    const firstEvents = new Promise((resolve) => {
      resolveFirstEvents = resolve;
    });
    const secondEvents = new Promise((resolve) => {
      resolveSecondEvents = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-1" ? firstEvents : secondEvents;
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    resolveSecondEvents({
      events: [
        {
          id: "event-second",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "item-2",
          payload: { delta: "Second thread replay" },
          receivedAt: "2026-04-30T00:00:01Z",
        },
      ],
    });

    expect(await screen.findByText(/second thread replay/i)).toBeInTheDocument();
    resolveFirstEvents({
      events: [
        {
          id: "event-first",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          payload: { delta: "Stale first thread replay" },
          receivedAt: "2026-04-30T00:00:02Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText(/stale first thread replay/i)).not.toBeInTheDocument();
    });
    const threadStreams = FakeEventSource.instances.filter((instance) => instance.url.includes("threadId="));
    expect(threadStreams).toHaveLength(1);
    expect(threadStreams[0].url).toContain("threadId=thread-2");
  });

  it("shows account login, rate limits, and model selection", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/account/rate-limits": {
          rateLimits: {
            primary: { usedPercent: 42, resetsAt: null, windowDurationMins: 300 },
            secondary: null,
            credits: null,
            limitId: "primary",
            limitName: "Primary",
            planType: "pro",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
          rawPayload: {},
        },
        "POST /v1/account/login": {
          loginType: "chatgpt",
          loginId: "login-1",
          authUrl: "https://chatgpt.com/login/device",
          verificationUrl: null,
          userCode: null,
          rawPayload: {},
        },
        "POST /v1/account/login/login-1/cancel": { payload: {} },
        "POST /v1/account/logout": { payload: {} },
      }),
    );

    render(<App />);

    const modelInputs = await screen.findAllByLabelText(/model/i);
    expect(modelInputs.find((element) => element.tagName === "INPUT")).toHaveValue("GPT-5.4");
    expect(await screen.findByText(/42% used/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /connect chatgpt/i }));

    expect(await screen.findByRole("link", { name: /open chatgpt auth/i })).toHaveAttribute(
      "href",
      "https://chatgpt.com/login/device",
    );
    expect(gateway.callsFor("POST", "/v1/account/login")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /cancel login/i }));
    expect(gateway.callsFor("POST", "/v1/account/login/login-1/cancel")).toHaveLength(1);
  });

  it("renders authenticated account state and logs out", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/account": {
          requiresOpenaiAuth: false,
          account: {
            accountType: "chatgpt",
            email: "dev@example.com",
            planType: "pro",
            rawPayload: {},
          },
          rawPayload: {},
        },
        "POST /v1/account/logout": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/dev@example\.com/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /logout/i }));
    expect(gateway.callsFor("POST", "/v1/account/logout")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /connect chatgpt/i })).toBeInTheDocument();
  });
});
