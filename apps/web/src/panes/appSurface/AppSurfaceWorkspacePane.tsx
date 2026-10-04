import { Alert, Loader } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  callAppSurfaceBridge,
  getThreadAppSurface,
  type AppSurfaceBridgeRequest,
  type AppSurfaceBridgeResponse,
} from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import { AppSurfacePane } from "../../appSurfaces/AppSurfacePane";
import { errorMessageFrom } from "../../shared/values";
import { readStoredKodexColorScheme } from "../../theme";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";

type ThreadAppSurfacePaneProps = {
  colorSchemeId: ReturnType<typeof readStoredKodexColorScheme>;
  emptyTitle?: string;
  targetSessionId?: string | null;
  threadId: string | null;
};

export function AppSurfaceWorkspacePane({ pane }: WorkspacePaneComponentProps) {
  const target = paneTargetRecord(pane);
  const threadId = typeof target.threadId === "string" ? target.threadId : null;
  const targetSessionId = typeof target.sessionId === "string" ? target.sessionId : null;
  const [colorSchemeId] = useState(() => readStoredKodexColorScheme());

  return (
    <ThreadAppSurfacePane
      colorSchemeId={colorSchemeId}
      emptyTitle={pane.title ?? "App Surface"}
      targetSessionId={targetSessionId}
      threadId={threadId}
    />
  );
}

function ThreadAppSurfacePane({
  colorSchemeId,
  emptyTitle = "App Surface",
  targetSessionId = null,
  threadId,
}: ThreadAppSurfacePaneProps) {
  const queryClient = useQueryClient();

  const sessionQuery = useQuery({
    enabled: threadId !== null,
    queryKey: threadId ? queryKeys.appSurface(threadId) : [...queryKeys.appSurfaceRoot, null],
    queryFn: ({ signal }) => {
      if (!threadId) {
        return null;
      }
      return getThreadAppSurface(threadId, signal);
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

      const response = await bridgeMutation.mutateAsync({
        request,
        sessionId: visibleSession.id,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.appSurface(visibleSession.threadId) });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response;
    },
    [bridgeMutation, queryClient, visibleSession],
  );

  if (!threadId) {
    return (
      <AppSurfaceEmptyState
        detail="This pane needs a thread target before it can show an app surface."
        title="App Surface"
      />
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <section className="kodex-workspace-placeholder-pane" data-pane-kind="appSurface">
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
      <AppSurfaceEmptyState
        detail={
          targetSessionId
            ? "The selected app surface session is no longer the latest session for this thread."
            : "No app surface session is available for this thread yet."
        }
        title={emptyTitle}
      />
    );
  }

  return (
    <AppSurfacePane
      colorSchemeId={colorSchemeId}
      isBridgePending={bridgeMutation.isPending}
      onBridgeRequest={handleBridgeRequest}
      session={visibleSession}
    />
  );
}

function AppSurfaceEmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <section className="kodex-workspace-placeholder-pane" data-pane-kind="appSurface">
      <div className="kodex-workspace-placeholder-icon" aria-hidden="true">
        <Sparkles size={18} strokeWidth={1.8} />
      </div>
      <div className="kodex-workspace-placeholder-copy">
        <span className="kodex-workspace-placeholder-eyebrow">App Surface</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </section>
  );
}
