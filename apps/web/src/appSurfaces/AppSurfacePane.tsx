import { Badge, Box, Text } from "@mantine/core";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppSurfaceBridgeRequest, AppSurfaceBridgeResponse, AppSurfaceSession } from "../api/client";
import { errorMessageFrom } from "../shared/values";
import type { KodexColorSchemeId } from "../theme";
import { buildAppSurfaceResourceHtml } from "./document";

const APP_SURFACE_TEXT = {
  documentLoadError: "App surface document failed to load.",
  frame: "App surface",
  sandboxConfigError:
    "App surface sandbox proxy must be configured on a different origin. Set VITE_KODEX_APP_SURFACE_SANDBOX_URL.",
  submitted: "Submitted",
  submitting: "Working",
};

const APP_SURFACE_SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const APP_SURFACE_SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
const APP_SURFACE_APP_INITIALIZED = "ui/notifications/initialized";
const APP_SURFACE_APP_SIZE_CHANGED = "ui/notifications/size-changed";
const DEFAULT_APP_IFRAME_SANDBOX = "allow-scripts allow-forms";

type AppSurfacePaneProps = {
  colorSchemeId: KodexColorSchemeId;
  isBridgePending: boolean;
  onBridgeRequest: (request: AppSurfaceBridgeRequest) => Promise<AppSurfaceBridgeResponse>;
  session: AppSurfaceSession;
};

type JsonRpcMessage = {
  id?: unknown;
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
  revision?: unknown;
  sessionId?: unknown;
};

type JsonRecord = Record<string, unknown>;

export function AppSurfacePane({ colorSchemeId, isBridgePending, onBridgeRequest, session }: AppSurfacePaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const postedToolNotificationsRef = useRef(false);
  const proxyReadyRef = useRef(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resourceHtml, setResourceHtml] = useState("");
  const statusLabel = session.status === "submitted" ? APP_SURFACE_TEXT.submitted : isBridgePending ? APP_SURFACE_TEXT.submitting : null;
  const frameTitle = useMemo(() => `${APP_SURFACE_TEXT.frame}: ${session.title}`, [session.title]);
  const sandboxUrl = useMemo(resolveAppSurfaceSandboxUrl, []);
  const sandboxError = sandboxUrl ? null : APP_SURFACE_TEXT.sandboxConfigError;

  useEffect(() => {
    setLocalError(null);
    proxyReadyRef.current = false;
    postedToolNotificationsRef.current = false;
  }, [session.id, session.revision]);

  const postCurrentResource = useCallback(() => {
    if (!resourceHtml) {
      return;
    }
    postedToolNotificationsRef.current = false;
    postProxyResource(iframeRef.current?.contentWindow ?? null, session, resourceHtml);
  }, [resourceHtml, session]);

  const markProxyReady = useCallback(() => {
    proxyReadyRef.current = true;
    postCurrentResource();
  }, [postCurrentResource]);

  const postSessionToolNotifications = useCallback(() => {
    if (postedToolNotificationsRef.current) {
      return;
    }
    postedToolNotificationsRef.current = true;
    postToolNotifications(iframeRef.current?.contentWindow ?? null, session);
  }, [session]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;
    setDocumentError(null);
    setResourceHtml("");

    void fetch(resolveAppSurfaceDocumentUrl(session.documentUrl), {
      headers: { Accept: "text/html" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${APP_SURFACE_TEXT.documentLoadError} (${response.status})`);
        }
        return response.text();
      })
      .then((html) => {
        if (isMounted) {
          setResourceHtml(buildAppSurfaceResourceHtml(html, colorSchemeId, session.csp));
        }
      })
      .catch((error) => {
        if (!isMounted || isAbortError(error)) {
          return;
        }
        setDocumentError(errorMessageFrom(error));
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [colorSchemeId, session.csp, session.documentUrl]);

  useEffect(() => {
    if (!proxyReadyRef.current) {
      return;
    }
    postCurrentResource();
  }, [postCurrentResource]);

  useEffect(() => {
    return () => {
      postJsonRpcNotification(iframeRef.current?.contentWindow ?? null, "ui/resource-teardown", {
        revision: session.revision,
        sessionId: session.id,
      });
    };
  }, [session.id, session.revision]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const proxyNotificationMethod = sandboxProxyNotificationMethodFromData(event.data);
      if (proxyNotificationMethod === APP_SURFACE_SANDBOX_PROXY_READY) {
        markProxyReady();
        return;
      }
      if (proxyNotificationMethod === APP_SURFACE_SANDBOX_RESOURCE_READY) {
        setLocalError(null);
        return;
      }
      if (proxyNotificationMethod) {
        return;
      }

      const notificationMethod = appNotificationMethodFromMessage(event.data, session.id, session.revision);
      if (notificationMethod) {
        if (notificationMethod === APP_SURFACE_APP_INITIALIZED) {
          postSessionToolNotifications();
          return;
        }
        if (notificationMethod === APP_SURFACE_APP_SIZE_CHANGED) {
          setLocalError(null);
          return;
        }
        const notificationRequest = bridgeRequestFromMessage(event.data, session.id, session.revision);
        if (!notificationRequest) {
          return;
        }
        const bridgeRequest = { ...notificationRequest, bridgeToken: session.bridgeToken };
        setLocalError(null);
        void onBridgeRequest(bridgeRequest).catch((error) => {
          setLocalError(errorMessageFrom(error));
        });
        return;
      }
      const request = bridgeRequestFromMessage(event.data, session.id, session.revision);
      if (!request) {
        return;
      }
      const bridgeRequest = { ...request, bridgeToken: session.bridgeToken };
      setLocalError(null);
      void onBridgeRequest(bridgeRequest)
        .then((response) => {
          postJsonRpcResponse(iframeRef.current?.contentWindow ?? null, bridgeRequest.id, response);
          if (bridgeRequest.method === "ui/initialize" && !response.error) {
            window.setTimeout(postSessionToolNotifications, 0);
          }
        })
        .catch((error) => {
          const message = errorMessageFrom(error);
          setLocalError(message);
          postJsonRpcError(iframeRef.current?.contentWindow ?? null, bridgeRequest.id, message);
        });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [markProxyReady, onBridgeRequest, postSessionToolNotifications, session.bridgeToken, session.id, session.revision]);

  return (
    <Box className="kodex-app-surface-pane" data-provider={session.provider} data-status={session.status}>
      {statusLabel ? (
        <Badge
          className="kodex-app-surface-status"
          leftSection={isBridgePending ? <Loader2 size={12} /> : <CheckCircle2 size={12} />}
          size="sm"
          variant="light"
        >
          {statusLabel}
        </Badge>
      ) : null}
      {documentError || localError || sandboxError ? (
        <Box className="kodex-app-surface-error" role="alert">
          <AlertCircle aria-hidden="true" size={14} />
          <Text component="span" size="xs">
            {documentError ?? localError ?? sandboxError}
          </Text>
        </Box>
      ) : null}
      {sandboxUrl ? (
        <Box className="kodex-app-surface-frame-wrap">
          <iframe
            className="kodex-app-surface-frame"
            key={`${session.id}:${session.revision}:${colorSchemeId}`}
            onLoad={markProxyReady}
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin"
            src={sandboxUrl}
            title={frameTitle}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function postToolNotifications(target: Window | null, session: AppSurfaceSession) {
  if (!target) {
    return;
  }
  const toolInput = toolInputFromSession(session);
  if (toolInput !== undefined) {
    postJsonRpcNotification(target, "ui/notifications/tool-input", { arguments: toolInput });
  }
  const toolResult = toolResultFromSession(session);
  if (toolResult !== undefined) {
    postJsonRpcNotification(target, "ui/notifications/tool-result", toolResult);
  }
}

function postJsonRpcNotification(target: Window | null, method: string, params: unknown) {
  postProxyHostMessage(target, { jsonrpc: "2.0", method, params: jsonRpcObject(params) });
}

function postJsonRpcResponse(target: Window | null, fallbackId: unknown, response: AppSurfaceBridgeResponse) {
  if (!target) {
    return;
  }
  const id = response.id ?? fallbackId ?? null;
  if (response.error) {
    postProxyHostMessage(target, { jsonrpc: "2.0", id, error: response.error });
    return;
  }
  postProxyHostMessage(target, { jsonrpc: "2.0", id, result: jsonRpcObject(response.result) });
}

function postJsonRpcError(target: Window | null, id: unknown, message: string) {
  if (!target) {
    return;
  }
  postProxyHostMessage(
    target,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32000, message },
    },
  );
}

function toolInputFromSession(session: AppSurfaceSession): unknown {
  const provenance = recordValue(session.provenance);
  const mcp = recordValue(provenance?.mcp);
  if (mcp && "arguments" in mcp) {
    return mcp.arguments;
  }
  if (provenance && "toolInput" in provenance) {
    return provenance.toolInput;
  }
  if (provenance && "input" in provenance) {
    return provenance.input;
  }
  return undefined;
}

function toolResultFromSession(session: AppSurfaceSession): unknown {
  const provenance = recordValue(session.provenance);
  const mcp = recordValue(provenance?.mcp);
  if (mcp && "result" in mcp) {
    return mcp.result;
  }
  if (provenance && "toolResult" in provenance) {
    return provenance.toolResult;
  }
  if (provenance && "result" in provenance) {
    return provenance.result;
  }
  return undefined;
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function jsonRpcObject(value: unknown): JsonRecord {
  const record = recordValue(value);
  if (!record) {
    return {};
  }
  const normalized = { ...record };
  if (normalized._meta === null) {
    delete normalized._meta;
  }
  return normalized;
}

function bridgeRequestFromMessage(data: unknown, currentSessionId: string, currentRevision: number): AppSurfaceBridgeRequest | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const message = data as JsonRpcMessage;
  if (typeof message.sessionId === "string" && message.sessionId !== currentSessionId) {
    return null;
  }
  if (message.method === undefined && (data as { type?: unknown }).type === "mcp-app/request") {
    const params = (data as { request?: JsonRpcMessage }).request;
    return params ? bridgeRequestFromMessage(params, currentSessionId, currentRevision) : null;
  }
  if (typeof message.method !== "string") {
    return null;
  }
  const revision = typeof message.revision === "number" ? message.revision : currentRevision;
  if (revision !== currentRevision) {
    return null;
  }
  return {
    id: message.id,
    revision,
    method: message.method,
    params: message.params ?? {},
  };
}

function appNotificationMethodFromMessage(data: unknown, currentSessionId: string, currentRevision: number): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const envelope = data as { type?: unknown; notification?: JsonRpcMessage };
  if (envelope.type === "mcp-app/notification" && envelope.notification) {
    return appNotificationMethodFromMessage(envelope.notification, currentSessionId, currentRevision);
  }
  const message = data as JsonRpcMessage;
  if (message.id !== undefined) {
    return null;
  }
  if (typeof message.sessionId === "string" && message.sessionId !== currentSessionId) {
    return null;
  }
  if (typeof message.method !== "string") {
    return null;
  }
  const revision = typeof message.revision === "number" ? message.revision : currentRevision;
  if (revision !== currentRevision) {
    return null;
  }
  return message.method;
}

function sandboxProxyNotificationMethodFromData(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const message = data as JsonRpcMessage;
  if (typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-")) {
    return message.method;
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveAppSurfaceDocumentUrl(documentUrl: string): string {
  if (typeof window === "undefined") {
    return documentUrl;
  }
  return new URL(documentUrl, window.location.origin).toString();
}

function resolveAppSurfaceSandboxUrl(): string | null {
  const configured = import.meta.env.VITE_KODEX_APP_SURFACE_SANDBOX_URL;
  if (typeof window === "undefined") {
    return configured || null;
  }
  const sandboxUrl = configured ? new URL(configured, window.location.href) : loopbackSiblingSandboxUrl();
  if (!sandboxUrl || sandboxUrl.origin === window.location.origin) {
    return null;
  }
  return sandboxUrl.toString();
}

function loopbackSiblingSandboxUrl(): URL | null {
  const current = new URL(window.location.href);
  const hostname = current.hostname;
  const siblingHost = loopbackSiblingHost(hostname) ?? sameMachineFallbackHost(current);
  if (!siblingHost) {
    return null;
  }
  const port = current.port ? `:${current.port}` : "";
  return new URL(`/app-surface-sandbox.html`, `${current.protocol}//${siblingHost}${port}`);
}

function loopbackSiblingHost(hostname: string): string | null {
  if (hostname === "localhost") {
    return "127.0.0.1";
  }
  if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "localhost";
  }
  return null;
}

function sameMachineFallbackHost(current: URL): string | null {
  if (current.protocol !== "http:") {
    return null;
  }
  return current.hostname ? "127.0.0.1" : null;
}

function postProxyResource(target: Window | null, session: AppSurfaceSession, html: string) {
  if (!target) {
    return;
  }
  target.postMessage(
    {
      jsonrpc: "2.0",
      method: APP_SURFACE_SANDBOX_RESOURCE_READY,
      params: {
        csp: session.csp,
        html,
        permissions: session.permissions,
        sandbox: DEFAULT_APP_IFRAME_SANDBOX,
      },
    },
    "*",
  );
}

function postProxyHostMessage(target: Window | null, message: unknown) {
  if (!target) {
    return;
  }
  target.postMessage(message, "*");
}
