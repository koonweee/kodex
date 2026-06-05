import { Alert, Loader } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Code2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  callAppSurfaceBridge,
  getThreadAppSurface,
  type AppSurfaceBridgeRequest,
  type AppSurfaceBridgeResponse,
  type QueuedInput,
} from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import { AppSurfacePane } from "../../appSurfaces/AppSurfacePane";
import { upsertCachedQueuedInput } from "../../queuedInputs/cache";
import { createClientRequestId } from "../../shared/id";
import { errorMessageFrom } from "../../shared/values";
import { readStoredKodexColorScheme } from "../../theme";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";

export function GeneratedUiWorkspacePane({ pane }: WorkspacePaneComponentProps) {
  const queryClient = useQueryClient();
  const { publishThreadPaneTimelineAction } = useWorkspace();
  const target = paneTargetRecord(pane);
  const threadId = typeof target.threadId === "string" ? target.threadId : null;
  const targetSessionId = typeof target.sessionId === "string" ? target.sessionId : null;
  const [colorSchemeId] = useState(() => readStoredKodexColorScheme());

  const sessionQuery = useQuery({
    enabled: threadId !== null,
    queryKey: threadId ? queryKeys.appSurface(threadId) : ["app-surface", "pane", pane.id, "none"],
    queryFn: () => {
      if (!threadId) {
        return null;
      }
      return getThreadAppSurface(threadId);
    },
  });

  const bridgeMutation = useMutation({
    mutationFn: ({
      request,
      sessionId,
    }: {
      request: AppSurfaceBridgeRequest;
      sessionId: string;
    }) => callAppSurfaceBridge(sessionId, request),
  });

  const session = sessionQuery.data ?? null;
  const visibleSession = useMemo(() => {
    if (!session) {
      return null;
    }
    if (targetSessionId && session.id !== targetSessionId) {
      return null;
    }
    return session;
  }, [session, targetSessionId]);

  const handleBridgeRequest = useCallback(
    async (request: AppSurfaceBridgeRequest): Promise<AppSurfaceBridgeResponse> => {
      if (!visibleSession) {
        return Promise.reject(new Error("No app surface session is available."));
      }

      const optimisticText = appSurfaceBridgeMessageText(request);
      const optimisticClientRequestId = optimisticText ? createClientRequestId() : null;
      if (optimisticText && optimisticClientRequestId) {
        publishThreadPaneTimelineAction({
          clientRequestId: optimisticClientRequestId,
          kind: "optimistic_user_started",
          skillMentions: [],
          text: optimisticText,
          threadId: visibleSession.threadId,
        });
      }

      try {
        const response = await bridgeMutation.mutateAsync({
          request,
          sessionId: visibleSession.id,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.appSurface(visibleSession.threadId) });
        if (response.error) {
          throw new Error(response.error.message);
        }
        const queuedInput = appSurfaceBridgeQueuedInput(response);
        if (queuedInput) {
          if (optimisticClientRequestId) {
            publishThreadPaneTimelineAction({
              clientRequestId: optimisticClientRequestId,
              kind: "optimistic_user_removed",
            });
          }
          upsertCachedQueuedInput(queryClient, queuedInput);
          return response;
        }
        if (optimisticClientRequestId) {
          publishThreadPaneTimelineAction({
            clientRequestId: optimisticClientRequestId,
            kind: "optimistic_user_sent",
          });
        }
        return response;
      } catch (error) {
        if (optimisticClientRequestId) {
          publishThreadPaneTimelineAction({
            clientRequestId: optimisticClientRequestId,
            kind: "optimistic_user_removed",
          });
        }
        throw error;
      }
    },
    [bridgeMutation, publishThreadPaneTimelineAction, queryClient, visibleSession],
  );

  if (!threadId) {
    return (
      <GeneratedUiEmptyState
        detail="This pane needs a thread target before it can show generated UI."
        title="Generated UI"
      />
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <section className="kodex-workspace-placeholder-pane" data-pane-kind="generatedUi">
        <Loader size="sm" />
      </section>
    );
  }

  if (sessionQuery.error) {
    return (
      <Alert className="kodex-workspace-pane-alert" icon={<AlertCircle size={16} />} color="red" variant="light">
        {errorMessageFrom(sessionQuery.error)}
      </Alert>
    );
  }

  if (!visibleSession) {
    return (
      <GeneratedUiEmptyState
        detail={
          targetSessionId
            ? "The selected generated UI session is no longer the latest session for this thread."
            : "No generated UI session is available for this thread yet."
        }
        title={pane.title ?? "Generated UI"}
      />
    );
  }

  return (
    <AppSurfacePane
      colorSchemeId={colorSchemeId}
      isBridgePending={bridgeMutation.isPending}
      onHide={() => undefined}
      onBridgeRequest={handleBridgeRequest}
      session={visibleSession}
    />
  );
}

function appSurfaceBridgeMessageText(request: AppSurfaceBridgeRequest): string | null {
  if (request.method !== "ui/message" || !request.params || typeof request.params !== "object") {
    return null;
  }
  const message = (request.params as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
}

function appSurfaceBridgeQueuedInput(response: AppSurfaceBridgeResponse): QueuedInput | null {
  if (!response.result || typeof response.result !== "object") {
    return null;
  }
  const result = response.result as { input?: unknown; queuedInput?: unknown };
  const directQueuedInput = queuedInputFromUnknown(result.queuedInput);
  if (directQueuedInput) {
    return directQueuedInput;
  }
  if (!result.input || typeof result.input !== "object") {
    return null;
  }
  return queuedInputFromUnknown((result.input as { queuedInput?: unknown }).queuedInput);
}

function queuedInputFromUnknown(value: unknown): QueuedInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Partial<QueuedInput>;
  return typeof row.id === "string" && typeof row.threadId === "string" ? (row as QueuedInput) : null;
}

function GeneratedUiEmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <section className="kodex-workspace-placeholder-pane" data-pane-kind="generatedUi">
      <div className="kodex-workspace-placeholder-icon" aria-hidden="true">
        <Code2 size={18} strokeWidth={1.8} />
      </div>
      <div className="kodex-workspace-placeholder-copy">
        <span className="kodex-workspace-placeholder-eyebrow">Generated UI</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </section>
  );
}
