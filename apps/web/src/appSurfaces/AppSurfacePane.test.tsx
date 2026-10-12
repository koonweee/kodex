import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { AppSurfaceBridgeRequest, AppSurfaceSession } from "../api/client";
import { AppSurfacePane } from "./AppSurfacePane";

type AppSurfacePaneBridge = ComponentProps<typeof AppSurfacePane>["onBridgeRequest"];
const SANDBOX_ORIGIN = "http://127.0.0.1:3000";

describe("AppSurfacePane", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_KODEX_APP_SURFACE_SANDBOX_URL", "");
    document
      .querySelector('meta[name="kodex-app-surface-sandbox-url"]')
      ?.remove();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards MCP-style JSON-RPC bridge requests from the iframe", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      result: { ok: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 3 }), { onBridgeRequest });

    postFromApp({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "export", arguments: { format: "png" } },
      revision: 3,
    }, 3);

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "call-1",
        method: "tools/call",
        params: { name: "export", arguments: { format: "png" } },
        revision: 3,
      });
    });
  });

  it.each([
    { label: "wrong origin", origin: "https://attacker.example", source: "iframe" },
    { label: "wrong source", origin: "sandbox", source: "window" },
  ])("rejects bridge requests from the $label", async ({ origin, source }) => {
    const onBridgeRequest = vi.fn().mockResolvedValue({ result: {} }) as unknown as AppSurfacePaneBridge;
    renderPane(appSurfaceSession(), { onBridgeRequest });
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;

    postFromProxy(
      { jsonrpc: "2.0", id: "crossed", method: "tools/call", params: { name: "crossed" } },
      {
        origin: origin === "sandbox" ? new URL(iframe.src).origin : origin,
        source: source === "iframe" ? iframe.contentWindow : window,
      },
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onBridgeRequest).not.toHaveBeenCalled();
  });

  it("ignores removed legacy app surface submit messages", () => {
    const onBridgeRequest = vi.fn() as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      type: "kodex.ui.submit",
      requestId: "submit-request-1",
      sessionId: "session-1",
      revision: 2,
      message: "  Choose the compact layout  ",
      metadata: { selected: "compact" },
    }, 2);

    expect(onBridgeRequest).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ignores unrecognized app messages without legacy acknowledgements", () => {
    const onBridgeRequest = vi.fn() as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      type: "kodex:submit-message",
      requestId: "wrong-submit-1",
      message: "Hi",
    }, 2);

    expect(onBridgeRequest).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("sends the themed app surface document to the sandbox proxy", async () => {
    renderPane(
      appSurfaceSession({
        csp: {
          connectDomains: ["https://api.example.test"],
          resourceDomains: ["https://cdn.example.test"],
        },
      }),
      {
        colorSchemeId: "paper-light",
        documentHtml: "<!doctype html><html><body><button>Pick</button></body></html>",
      },
    );

    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const { postMessage } = mockProxyPostMessage(iframe);
    expect(iframe).toHaveAttribute("src", "http://127.0.0.1:3000/app-surface-sandbox.html");
    expect(iframe).not.toHaveAttribute("srcdoc");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    postProxyReady();

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: expect.objectContaining({
            backgroundColor: "#fcfaf4",
            html: expect.stringContaining("kodex-app-surface-theme"),
          }),
        }),
        "http://127.0.0.1:3000",
      );
    });
    const resourceMessage = postMessage.mock.calls.find((call) => call[0]?.method === "ui/notifications/sandbox-resource-ready")?.[0];
    expect(resourceMessage.params.html).toContain("--kodex-bg-app: #ece6db;");
    expect(resourceMessage.params.html).toContain("connect-src https://api.example.test");
    expect(resourceMessage.params.html).toContain("img-src https://cdn.example.test");
    expect(resourceMessage.params.html).toContain("<button>Pick</button>");
    expect(resourceMessage.params.csp).toEqual({
      connectDomains: ["https://api.example.test"],
      resourceDomains: ["https://cdn.example.test"],
    });
    expect(resourceMessage.params.permissions).toEqual({});
    expect(resourceMessage.params.sandbox).toBe("allow-scripts allow-forms");
  });

  it("uses the federator runtime sandbox origin", () => {
    const meta = document.createElement("meta");
    meta.name = "kodex-app-surface-sandbox-url";
    meta.content = "https://kodex-sandbox.tailnet.example/app-surface-sandbox.html";
    document.head.append(meta);

    renderPane(appSurfaceSession());

    expect(screen.getByTitle(/app surface:/i)).toHaveAttribute(
      "src",
      "https://kodex-sandbox.tailnet.example/app-surface-sandbox.html",
    );
  });

  it("sends the app surface document when the proxy ready message is missed", async () => {
    renderPane(appSurfaceSession(), {
      documentHtml: "<!doctype html><html><body><button>Pick</button></body></html>",
    });

    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const { postMessage } = mockProxyPostMessage(iframe);
    fireEvent.load(iframe);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: expect.objectContaining({
            html: expect.stringContaining("<button>Pick</button>"),
          }),
        }),
        SANDBOX_ORIGIN,
      );
    });
  });

  it("resends the app surface document when an already-ready sandbox iframe reloads", async () => {
    renderPane(appSurfaceSession(), {
      documentHtml: "<!doctype html><html><body><button>Pick</button></body></html>",
    });

    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const { postMessage } = mockProxyPostMessage(iframe);
    fireEvent.load(iframe);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: expect.objectContaining({
            html: expect.stringContaining("<button>Pick</button>"),
          }),
        }),
        SANDBOX_ORIGIN,
      );
    });
    postMessage.mockClear();

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: expect.objectContaining({
            html: expect.stringContaining("<button>Pick</button>"),
          }),
        }),
        SANDBOX_ORIGIN,
      );
    });
  });

  it("replays MCP tool notifications after a sandbox reload resets the embedded app", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "init-1",
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "Kodex", version: "0.1.0" },
        hostCapabilities: { resources: { read: true }, tools: { call: true } },
        hostContext: { displayMode: "pane" },
      },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(
      appSurfaceSession({
        provider: "mcp",
        provenance: {
          mcp: {
            arguments: { amount: 100000 },
            result: { content: [{ type: "text", text: "Budget rows" }] },
          },
        },
      }),
      { onBridgeRequest },
    );

    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const { postMessage } = mockProxyPostMessage(iframe);
    fireEvent.load(iframe);
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "ui/notifications/sandbox-resource-ready",
        }),
        SANDBOX_ORIGIN,
      );
    });
    postMessage.mockClear();

    postFromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { amount: 100000 } },
        },
        SANDBOX_ORIGIN,
      );
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: "Budget rows" }] },
        },
        SANDBOX_ORIGIN,
      );
    });
    postMessage.mockClear();

    fireEvent.load(iframe);
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "ui/notifications/sandbox-resource-ready",
        }),
        SANDBOX_ORIGIN,
      );
    });
    postMessage.mockClear();

    postFromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { amount: 100000 } },
        },
        SANDBOX_ORIGIN,
      );
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: "Budget rows" }] },
        },
        SANDBOX_ORIGIN,
      );
    });
  });

  it("answers MCP app initialization and posts tool notifications after the app is ready", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "init-1",
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "Kodex", version: "0.1.0" },
        hostCapabilities: { resources: { read: true }, tools: { call: true } },
        hostContext: { displayMode: "pane" },
      },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(
      appSurfaceSession({
        provider: "mcp",
        grants: {
          canOpenLinks: true,
          canSendMessage: true,
          canUpdateModelContext: true,
          resources: [],
          tools: [],
        },
        provenance: {
          mcp: {
            arguments: { color: "blue" },
            result: { _meta: null, content: [{ type: "text", text: "Rendered sketch" }] },
          },
        },
        revision: 4,
      }),
      { onBridgeRequest },
    );

    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const { postMessage } = mockProxyPostMessage(iframe);

    expect(postMessage).not.toHaveBeenCalled();

    postFromApp({
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: {
        appInfo: { name: "Budget Allocator", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      },
      revision: 4,
    }, 4);

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "init-1",
        method: "ui/initialize",
        params: {
          appInfo: { name: "Budget Allocator", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
        revision: 4,
      });
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "init-1",
          result: expect.objectContaining({
            hostInfo: { name: "Kodex", version: "0.1.0" },
            protocolVersion: "2026-01-26",
          }),
        },
        SANDBOX_ORIGIN,
      );
    });

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { color: "blue" } },
        },
        SANDBOX_ORIGIN,
      );
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: "Rendered sketch" }] },
        },
        SANDBOX_ORIGIN,
      );
    });

    const callsAfterInitialize = postMessage.mock.calls.length;
    postFromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
      revision: 4,
    }, 4);
    expect(postMessage.mock.calls).toHaveLength(callsAfterInitialize);
  });

  it("discards a held bridge completion after the iframe session is replaced", async () => {
    let resolveBridge: (response: { id: string; result: Record<string, unknown> }) => void = () => undefined;
    const onBridgeRequest = vi.fn(() => new Promise((resolve) => {
      resolveBridge = resolve;
    })) as unknown as AppSurfacePaneBridge;
    const firstSession = appSurfaceSession({
      provenance: { toolInput: { from: "old revision" } },
      revision: 1,
    });
    const rendered = renderPane(firstSession, { onBridgeRequest });
    const firstIframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const firstPostMessage = mockProxyPostMessage(firstIframe).postMessage;

    postFromApp({
      jsonrpc: "2.0",
      id: "same-request-id",
      method: "ui/initialize",
      params: { appInfo: { name: "Old app" }, appCapabilities: {}, protocolVersion: "2026-01-26" },
      revision: 1,
    }, 1);
    await waitFor(() => expect(onBridgeRequest).toHaveBeenCalledTimes(1));

    const replacementSession = appSurfaceSession({
      bridgeToken: "bridge-token-2",
      id: "session-2",
      documentUrl: "/v1/app-surfaces/session-2/document?revision=2",
      provenance: { toolInput: { from: "new revision" } },
      revision: 2,
    });
    const defaultBridge: AppSurfacePaneBridge = async (request) => ({ id: request.id, result: {} });
    rendered.rerender(appSurfacePaneElement(replacementSession, { onBridgeRequest }, defaultBridge));
    const replacementIframe = await screen.findByTitle(/app surface:/i) as HTMLIFrameElement;
    const replacementPostMessage = mockProxyPostMessage(replacementIframe).postMessage;
    firstPostMessage.mockClear();
    replacementPostMessage.mockClear();

    resolveBridge({ id: "same-request-id", result: { authorizedFor: "old revision" } });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(firstPostMessage).not.toHaveBeenCalled();
    expect(replacementPostMessage).not.toHaveBeenCalled();
  });

  it("forwards ui/open-link through the bridge without opening browser windows itself", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "link-1",
      result: { opened: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });

    postFromApp({
      jsonrpc: "2.0",
      id: "link-1",
      method: "ui/open-link",
      params: { url: "https://example.test/doc" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "link-1",
        method: "ui/open-link",
        params: { url: "https://example.test/doc" },
        revision: 2,
      });
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("forwards app log notifications through the bridge without posting a response", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({ result: {} }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", message: "Loaded records" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        method: "notifications/message",
        params: { level: "info", message: "Loaded records" },
        revision: 2,
      });
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("consumes app size change notifications without forwarding them through the bridge", () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({ result: {} }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 420, width: 360 },
      revision: 2,
    }, 2);

    expect(onBridgeRequest).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("posts normalized JSON-RPC result responses without undefined error fields", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      result: { _meta: null, ok: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "export" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: { ok: true },
        },
        SANDBOX_ORIGIN,
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("posts normalized JSON-RPC error responses without undefined result fields", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      error: { code: -32001, message: "Approval required" },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "export" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          error: { code: -32001, message: "Approval required" },
        },
        SANDBOX_ORIGIN,
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("result");
  });

  it("normalizes bridge responses with no result to an empty JSON-RPC result object", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "export" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: {},
        },
        SANDBOX_ORIGIN,
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("normalizes null JSON-RPC result responses to an empty result object", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      result: null,
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const { postMessage } = mockProxyPostMessage();

    postFromApp({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "export" },
      revision: 2,
    }, 2);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: {},
        },
        SANDBOX_ORIGIN,
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("does not duplicate the app surface title as a host pane heading", () => {
    renderPane(appSurfaceSession());

    expect(screen.getByTitle(/app surface: mockups/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Mockups" })).not.toBeInTheDocument();
  });
});

function renderPane(
  session: AppSurfaceSession,
  overrides: {
    colorSchemeId?: ComponentProps<typeof AppSurfacePane>["colorSchemeId"];
    documentHtml?: string;
    onBridgeRequest?: AppSurfacePaneBridge;
  } = {},
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(overrides.documentHtml ?? "<main>App surface</main>", {
      headers: { "Content-Type": "text/html" },
    }),
  );
  const defaultBridge: AppSurfacePaneBridge = async (request: AppSurfaceBridgeRequest) => ({
    id: request.id,
    result: {},
  });
  return render(appSurfacePaneElement(session, overrides, defaultBridge));
}

function appSurfacePaneElement(
  session: AppSurfaceSession,
  overrides: {
    colorSchemeId?: ComponentProps<typeof AppSurfacePane>["colorSchemeId"];
    onBridgeRequest?: AppSurfacePaneBridge;
  },
  defaultBridge: AppSurfacePaneBridge,
) {
  return (
    <MantineProvider>
      <AppSurfacePane
        colorSchemeId={overrides.colorSchemeId ?? "oled-black"}
        isBridgePending={false}
        loadDocument={async (documentUrl, signal) => {
          const response = await fetch(documentUrl, { headers: { Accept: "text/html" }, signal });
          if (!response.ok) throw new Error(`App surface document failed to load. (${response.status})`);
          return response.text();
        }}
        onBridgeRequest={overrides.onBridgeRequest ?? defaultBridge}
        session={session}
      />
    </MantineProvider>
  );
}

function mockProxyPostMessage(iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement) {
  const postMessage = vi.fn();
  Object.defineProperty(iframe.contentWindow, "postMessage", {
    configurable: true,
    value: postMessage,
  });
  return { iframe, postMessage };
}

function postFromApp(message: unknown, revision = 1) {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    postFromProxy({ revision, ...(message as Record<string, unknown>) });
    return;
  }
  postFromProxy(message);
}

function postProxyReady() {
  postFromProxy({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
}

function postFromProxy(
  data: unknown,
  overrides: { origin?: string; source?: MessageEventSource | null } = {},
) {
  const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", {
    data,
    origin: overrides.origin ?? new URL(iframe.src).origin,
  });
  Object.defineProperty(event, "source", { value: overrides.source ?? iframe.contentWindow });
  window.dispatchEvent(event);
}

function appSurfaceSession(overrides: Partial<AppSurfaceSession> = {}): AppSurfaceSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    csp: { connectDomains: [], resourceDomains: [] },
    displayModes: ["pane"],
    documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
    fallbackContent: "Mockups",
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
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
