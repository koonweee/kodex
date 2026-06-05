import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { AppSurfaceBridgeRequest, AppSurfaceSession } from "../api/client";
import { AppSurfacePane } from "./AppSurfacePane";

type AppSurfacePaneBridge = ComponentProps<typeof AppSurfacePane>["onBridgeRequest"];

describe("AppSurfacePane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards MCP-style JSON-RPC bridge requests from the iframe", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      result: { ok: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 3 }), { onBridgeRequest });

    postFromFrame({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { server: "sketch", tool: "export", arguments: { format: "png" } },
      revision: 3,
    });

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "call-1",
        method: "tools/call",
        params: { server: "sketch", tool: "export", arguments: { format: "png" } },
        revision: 3,
      });
    });
  });

  it("converts legacy generated UI submit messages into ui/message bridge requests", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "submit-request-1",
      result: { input: { disposition: "started", queuedInput: null, rawPayload: {} } },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      type: "kodex.ui.submit",
      requestId: "submit-request-1",
      sessionId: "session-1",
      revision: 2,
      message: "  Choose the compact layout  ",
      metadata: { selected: "compact" },
    });

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "submit-request-1",
        method: "ui/message",
        params: {
          message: "Choose the compact layout",
          metadata: { selected: "compact" },
        },
        revision: 2,
      });
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: "kodex.generatedUi.submit.result",
          requestId: "submit-request-1",
          ok: true,
          status: "submitted",
          result: { input: { disposition: "started", queuedInput: null, rawPayload: {} } },
        },
        "*",
      );
    });
  });

  it("reports unrecognized kodex postMessage event types back to the iframe", async () => {
    const onBridgeRequest = vi.fn() as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      type: "kodex:submit-message",
      requestId: "wrong-submit-1",
      message: "Hi",
    });

    expect(onBridgeRequest).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "kodex.generatedUi.submit.result",
        requestId: "wrong-submit-1",
        ok: false,
        status: "ignored",
        error: {
          code: "unrecognized_event_type",
          message: "Unrecognized generated UI event type: kodex:submit-message",
        },
      },
      "*",
    );
  });

  it("loads the app surface document into a themed iframe srcDoc", async () => {
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
    await waitFor(() => {
      expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("kodex-generated-ui-theme"));
    });
    expect(iframe).not.toHaveAttribute("src");
    expect(iframe.getAttribute("srcdoc")).toContain("--kodex-bg-app: #ece6db;");
    expect(iframe.getAttribute("srcdoc")).toContain("connect-src https://api.example.test");
    expect(iframe.getAttribute("srcdoc")).toContain("img-src data: blob: https://cdn.example.test");
    expect(iframe.getAttribute("srcdoc")).toContain("<button>Pick</button>");
  });

  it("answers MCP app initialization and posts tool notifications after the app is ready", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "init-1",
      result: {
        protocolVersion: "2025-11-21",
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
    await waitFor(() => {
      expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("kodex-generated-ui-theme"));
    });
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    fireEvent.load(iframe);

    expect(postMessage).not.toHaveBeenCalled();

    postFromFrame({
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: {
        appInfo: { name: "Budget Allocator", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2025-11-21",
      },
      revision: 4,
    });

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledWith({
        bridgeToken: "bridge-token-1",
        id: "init-1",
        method: "ui/initialize",
        params: {
          appInfo: { name: "Budget Allocator", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: "2025-11-21",
        },
        revision: 4,
      });
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "init-1",
          result: expect.objectContaining({
            hostInfo: { name: "Kodex", version: "0.1.0" },
            protocolVersion: "2025-11-21",
          }),
        },
        "*",
      );
    });

    postFromFrame({
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
      revision: 4,
    });

    await waitFor(() => {
      expect(onBridgeRequest).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { color: "blue" } },
        },
        "*",
      );
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: "Rendered sketch" }] },
        },
        "*",
      );
    });
  });

  it("forwards ui/open-link through the bridge without opening browser windows itself", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "link-1",
      result: { opened: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });

    postFromFrame({
      jsonrpc: "2.0",
      id: "link-1",
      method: "ui/open-link",
      params: { url: "https://example.test/doc" },
      revision: 2,
    });

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

  it("posts normalized JSON-RPC result responses without undefined error fields", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
      result: { _meta: null, ok: true },
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { server: "sketch", tool: "export" },
      revision: 2,
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: { ok: true },
        },
        "*",
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
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { server: "sketch", tool: "export" },
      revision: 2,
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          error: { code: -32001, message: "Approval required" },
        },
        "*",
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("result");
  });

  it("normalizes bridge responses with no result to an empty JSON-RPC result object", async () => {
    const onBridgeRequest = vi.fn().mockResolvedValue({
      id: "call-1",
    }) as unknown as AppSurfacePaneBridge;

    renderPane(appSurfaceSession({ revision: 2 }), { onBridgeRequest });
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { server: "sketch", tool: "export" },
      revision: 2,
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: {},
        },
        "*",
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
    const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { server: "sketch", tool: "export" },
      revision: 2,
    });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          jsonrpc: "2.0",
          id: "call-1",
          result: {},
        },
        "*",
      );
    });
    expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("hides through the mobile pane header control", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(max-width: 900px)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    const onHide = vi.fn();
    renderPane(appSurfaceSession(), { onHide });

    await userEvent.click(screen.getByRole("button", { name: /hide app surface/i }));

    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

function renderPane(
  session: AppSurfaceSession,
  overrides: {
    colorSchemeId?: ComponentProps<typeof AppSurfacePane>["colorSchemeId"];
    documentHtml?: string;
    onBridgeRequest?: AppSurfacePaneBridge;
    onHide?: () => void;
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
  return render(
    <MantineProvider>
      <AppSurfacePane
        colorSchemeId={overrides.colorSchemeId ?? "oled-black"}
        isBridgePending={false}
        onBridgeRequest={overrides.onBridgeRequest ?? defaultBridge}
        onHide={overrides.onHide ?? vi.fn()}
        session={session}
      />
    </MantineProvider>,
  );
}

function postFromFrame(data: unknown) {
  const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
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
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
