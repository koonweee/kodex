import { ActionIcon, Badge, Box, Group, Text, Title, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AlertCircle, CheckCircle2, Loader2, PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppSurfaceBridgeRequest, AppSurfaceBridgeResponse, AppSurfaceSession } from "../api/client";
import { errorMessageFrom } from "../shared/values";
import type { KodexColorSchemeId } from "../theme";
import { buildGeneratedUiSrcDoc } from "../generatedUi/themeDocument";

const APP_SURFACE_TEXT = {
  close: "Hide app surface",
  documentLoadError: "App surface document failed to load.",
  frame: "App surface",
  submitted: "Submitted",
  submitting: "Working",
};

type AppSurfacePaneProps = {
  colorSchemeId: KodexColorSchemeId;
  isBridgePending: boolean;
  onBridgeRequest: (request: AppSurfaceBridgeRequest) => Promise<AppSurfaceBridgeResponse>;
  onHide: () => void;
  session: AppSurfaceSession;
};

type LegacySubmitMessage = {
  type?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  revision?: unknown;
  message?: unknown;
  visibleMessage?: unknown;
  text?: unknown;
  metadata?: unknown;
  json?: unknown;
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

export function AppSurfacePane({ colorSchemeId, isBridgePending, onBridgeRequest, onHide, session }: AppSurfacePaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const postedToolNotificationsRef = useRef(false);
  const showPaneClose = useMediaQuery("(max-width: 900px)", false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState("");
  const statusLabel = session.status === "submitted" ? APP_SURFACE_TEXT.submitted : isBridgePending ? APP_SURFACE_TEXT.submitting : null;
  const frameTitle = useMemo(() => `${APP_SURFACE_TEXT.frame}: ${session.title}`, [session.title]);

  useEffect(() => {
    setLocalError(null);
    postedToolNotificationsRef.current = false;
  }, [session.id, session.revision]);

  const postSessionToolNotifications = useCallback(() => {
    if (postedToolNotificationsRef.current) {
      return;
    }
    postedToolNotificationsRef.current = true;
    postToolNotifications(iframeRef.current?.contentWindow ?? null, session);
  }, [session]);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    setDocumentError(null);
    setSrcDoc("");

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
        if (isActive) {
          setSrcDoc(buildGeneratedUiSrcDoc(html, colorSchemeId, session.csp));
        }
      })
      .catch((error) => {
        if (!isActive || isAbortError(error)) {
          return;
        }
        setDocumentError(errorMessageFrom(error));
      });

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [colorSchemeId, session.documentUrl]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const notificationMethod = appNotificationMethodFromMessage(event.data, session.id, session.revision);
      if (notificationMethod) {
        if (notificationMethod === "ui/notifications/initialized") {
          postSessionToolNotifications();
        }
        return;
      }
      const legacySubmitRequest = legacySubmitRequestFromMessage(event.data, session.id, session.revision);
      if (legacySubmitRequest) {
        const bridgeRequest = { ...legacySubmitRequest, bridgeToken: session.bridgeToken };
        setLocalError(null);
        void onBridgeRequest(bridgeRequest)
          .then((response) => {
            iframeRef.current?.contentWindow?.postMessage(
              {
                jsonrpc: "2.0",
                id: response.id ?? bridgeRequest.id ?? null,
                result: response.result ?? undefined,
                error: response.error ?? undefined,
              },
              "*",
            );
            postGeneratedUiSubmitResult(iframeRef.current?.contentWindow ?? null, bridgeRequest.id, response);
          })
          .catch((error) => {
            const message = errorMessageFrom(error);
            setLocalError(message);
            iframeRef.current?.contentWindow?.postMessage(
              {
                jsonrpc: "2.0",
                id: bridgeRequest.id ?? null,
                error: { code: -32000, message },
              },
              "*",
            );
            postGeneratedUiSubmitResult(iframeRef.current?.contentWindow ?? null, bridgeRequest.id, {
              id: bridgeRequest.id,
              error: { code: -32000, message },
            });
          });
        return;
      }
      const request = bridgeRequestFromMessage(event.data, session.id, session.revision);
      if (!request) {
        const unrecognizedKodexType = unrecognizedGeneratedUiEventTypeFromMessage(event.data);
        if (unrecognizedKodexType) {
          postGeneratedUiIgnoredResult(
            iframeRef.current?.contentWindow ?? null,
            requestIdFromMessage(event.data),
            `Unrecognized generated UI event type: ${unrecognizedKodexType}`,
          );
        }
        return;
      }
      const bridgeRequest = { ...request, bridgeToken: session.bridgeToken };
      setLocalError(null);
      void onBridgeRequest(bridgeRequest)
        .then((response) => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: response.id ?? bridgeRequest.id ?? null,
              result: response.result ?? undefined,
              error: response.error ?? undefined,
            },
            "*",
          );
          if (bridgeRequest.method === "ui/initialize" && !response.error) {
            window.setTimeout(postSessionToolNotifications, 0);
          }
        })
        .catch((error) => {
          const message = errorMessageFrom(error);
          setLocalError(message);
          iframeRef.current?.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: bridgeRequest.id ?? null,
              error: { code: -32000, message },
            },
            "*",
          );
        });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onBridgeRequest, postSessionToolNotifications, session.bridgeToken, session.id, session.revision]);

  const handleFrameLoad = useCallback(() => {
    if (!srcDoc) {
      return;
    }
    setLocalError(null);
  }, [srcDoc]);

  return (
    <Box className="kodex-generated-ui-pane" data-provider={session.provider} data-status={session.status}>
      <Group className="kodex-generated-ui-header" justify="space-between" wrap="nowrap">
        <Group className="kodex-generated-ui-heading" gap="xs" wrap="nowrap">
          <Title className="kodex-generated-ui-title" order={3} size="h6" title={session.title}>
            {session.title}
          </Title>
          {statusLabel ? (
            <Badge
              className="kodex-generated-ui-status"
              leftSection={isBridgePending ? <Loader2 size={12} /> : <CheckCircle2 size={12} />}
              size="sm"
              variant="light"
            >
              {statusLabel}
            </Badge>
          ) : null}
        </Group>
        {showPaneClose ? (
          <Tooltip label={APP_SURFACE_TEXT.close}>
            <ActionIcon
              aria-label={APP_SURFACE_TEXT.close}
              className="kodex-generated-ui-close"
              onClick={onHide}
              variant="subtle"
            >
              <PanelRightClose size={17} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      {documentError || localError ? (
        <Box className="kodex-generated-ui-error" role="alert">
          <AlertCircle aria-hidden="true" size={14} />
          <Text component="span" size="xs">
            {documentError ?? localError}
          </Text>
        </Box>
      ) : null}
      <Box className="kodex-generated-ui-frame-wrap">
        <iframe
          className="kodex-generated-ui-frame"
          key={`${session.id}:${session.revision}:${colorSchemeId}`}
          onLoad={handleFrameLoad}
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={frameTitle}
        />
      </Box>
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

function postJsonRpcNotification(target: Window, method: string, params: unknown) {
  target.postMessage({ jsonrpc: "2.0", method, params }, "*");
}

function postGeneratedUiSubmitResult(
  target: Window | null,
  requestId: unknown,
  response: AppSurfaceBridgeResponse,
) {
  if (!target || typeof requestId !== "string") {
    return;
  }
  if (response.error) {
    target.postMessage(
      {
        type: "kodex.generatedUi.submit.result",
        requestId,
        ok: false,
        status: "error",
        error: response.error,
      },
      "*",
    );
    return;
  }
  target.postMessage(
    {
      type: "kodex.generatedUi.submit.result",
      requestId,
      ok: true,
      status: "submitted",
      result: response.result ?? {},
    },
    "*",
  );
}

function postGeneratedUiIgnoredResult(target: Window | null, requestId: unknown, message: string) {
  if (!target || typeof requestId !== "string") {
    return;
  }
  target.postMessage(
    {
      type: "kodex.generatedUi.submit.result",
      requestId,
      ok: false,
      status: "ignored",
      error: {
        code: "unrecognized_event_type",
        message,
      },
    },
    "*",
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

function requestIdFromMessage(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return (data as { requestId?: unknown }).requestId;
}

function unrecognizedGeneratedUiEventTypeFromMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string" || !type.startsWith("kodex")) {
    return null;
  }
  if (
    type === "kodex.generatedUi.submit" ||
    type === "kodex:generated-ui:submit" ||
    type === "kodex.ui.submit"
  ) {
    return null;
  }
  return type;
}

function legacySubmitRequestFromMessage(
  data: unknown,
  currentSessionId: string,
  currentRevision: number,
): AppSurfaceBridgeRequest | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const message = data as LegacySubmitMessage;
  if (
    message.type !== "kodex.generatedUi.submit" &&
    message.type !== "kodex:generated-ui:submit" &&
    message.type !== "kodex.ui.submit"
  ) {
    return null;
  }
  if (typeof message.sessionId === "string" && message.sessionId !== currentSessionId) {
    return null;
  }
  const revision = typeof message.revision === "number" ? message.revision : currentRevision;
  if (revision !== currentRevision) {
    return null;
  }
  const visibleMessage =
    typeof message.message === "string"
      ? message.message
      : typeof message.visibleMessage === "string"
        ? message.visibleMessage
        : typeof message.text === "string"
          ? message.text
          : "";
  const trimmedMessage = visibleMessage.trim();
  if (!trimmedMessage) {
    return null;
  }
  return {
    id: typeof message.requestId === "string" ? message.requestId : `legacy-submit:${currentSessionId}:${revision}`,
    revision,
    method: "ui/message",
    params: {
      message: trimmedMessage,
      metadata: message.metadata ?? message.json,
    },
  };
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
