import { ActionIcon, Badge, Box, Group, Text, Title, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AlertCircle, CheckCircle2, Loader2, PanelRightClose } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GeneratedUiSession, GeneratedUiSubmitRequest, GeneratedUiSubmitResponse } from "../api/client";
import { errorMessageFrom } from "../shared/values";
import type { KodexColorSchemeId } from "../theme";
import { buildGeneratedUiSrcDoc } from "./themeDocument";

const GENERATED_UI_TEXT = {
  close: "Hide generated UI",
  documentLoadError: "Generated UI document failed to load.",
  frame: "Generated UI",
  submitted: "Submitted",
  submitting: "Submitting",
};

type GeneratedUiPaneProps = {
  colorSchemeId: KodexColorSchemeId;
  isSubmitting: boolean;
  onHide: () => void;
  onSubmit: (request: GeneratedUiSubmitRequest) => Promise<GeneratedUiSubmitResponse>;
  session: GeneratedUiSession;
};

type GeneratedUiSubmitMessage = {
  type?: unknown;
  sessionId?: unknown;
  revision?: unknown;
  message?: unknown;
  visibleMessage?: unknown;
  text?: unknown;
  metadata?: unknown;
  json?: unknown;
};

export function GeneratedUiPane({ colorSchemeId, isSubmitting, onHide, onSubmit, session }: GeneratedUiPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const showPaneClose = useMediaQuery("(max-width: 900px)", false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSubmittedRevision, setLocalSubmittedRevision] = useState<number | null>(null);
  const [srcDoc, setSrcDoc] = useState("");
  const submitAvailable =
    session.submitAvailable && session.status === "interactive" && localSubmittedRevision !== session.revision;
  const statusLabel = session.status === "submitted" ? GENERATED_UI_TEXT.submitted : isSubmitting ? GENERATED_UI_TEXT.submitting : null;
  const frameTitle = useMemo(() => `${GENERATED_UI_TEXT.frame}: ${session.title}`, [session.title]);

  useEffect(() => {
    setLocalError(null);
    setLocalSubmittedRevision(null);
  }, [session.id, session.revision]);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    setDocumentError(null);
    setSrcDoc("");

    void fetch(resolveGeneratedUiDocumentUrl(session.documentUrl), {
      headers: { Accept: "text/html" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${GENERATED_UI_TEXT.documentLoadError} (${response.status})`);
        }
        return response.text();
      })
      .then((html) => {
        if (!isActive) {
          return;
        }
        setSrcDoc(buildGeneratedUiSrcDoc(html, colorSchemeId));
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
      const request = submitRequestFromMessage(event.data, session.id, session.revision);
      if (!request) {
        return;
      }
      if (!submitAvailable || isSubmitting) {
        setLocalError("This UI revision has already been submitted.");
        return;
      }
      setLocalError(null);
      setLocalSubmittedRevision(request.revision);
      void onSubmit(request).catch((error) => {
        setLocalSubmittedRevision(null);
        setLocalError(errorMessageFrom(error));
      });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isSubmitting, onSubmit, session.id, session.revision, submitAvailable]);

  return (
    <Box className="kodex-generated-ui-pane" data-status={session.status}>
      <Group className="kodex-generated-ui-header" justify="space-between" wrap="nowrap">
        <Group className="kodex-generated-ui-heading" gap="xs" wrap="nowrap">
          <Title className="kodex-generated-ui-title" order={3} size="h6" title={session.title}>
            {session.title}
          </Title>
          {statusLabel ? (
            <Badge
              className="kodex-generated-ui-status"
              leftSection={isSubmitting ? <Loader2 size={12} /> : <CheckCircle2 size={12} />}
              size="sm"
              variant="light"
            >
              {statusLabel}
            </Badge>
          ) : null}
        </Group>
        {showPaneClose ? (
          <Tooltip label={GENERATED_UI_TEXT.close}>
            <ActionIcon
              aria-label={GENERATED_UI_TEXT.close}
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
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={frameTitle}
        />
      </Box>
    </Box>
  );
}

function submitRequestFromMessage(data: unknown, currentSessionId: string, currentRevision: number): GeneratedUiSubmitRequest | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const message = data as GeneratedUiSubmitMessage;
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
    revision,
    message: trimmedMessage,
    metadata: message.metadata ?? message.json,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveGeneratedUiDocumentUrl(documentUrl: string): string {
  if (typeof window === "undefined") {
    return documentUrl;
  }
  return new URL(documentUrl, window.location.origin).toString();
}
