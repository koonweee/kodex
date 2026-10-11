import { useCallback, useEffect, useState } from "react";

import {
  type CreateTerminalSession,
  type TerminalSessionInfo,
} from "../api/client";
import { useGatewayClient } from "../api/GatewayClientContext";
import type { GatewayClient } from "../api/gatewayClient";
import { errorMessageFrom } from "../shared/values";

type GatewayTerminalSessionState = {
  error: string | null;
  isLoading: boolean;
  session: TerminalSessionInfo | null;
};

type GatewayTerminalSessionOptions = {
  createRequest?: CreateTerminalSession;
  preferredTerminalId?: string | null;
  reuseRunning?: boolean;
};

export function useGatewayTerminalSession(opened: boolean, options: GatewayTerminalSessionOptions = {}) {
  const api = useGatewayClient();
  const {
    createRequest = {},
    preferredTerminalId = null,
    reuseRunning = true,
  } = options;
  const [state, setState] = useState<GatewayTerminalSessionState>({
    error: null,
    isLoading: false,
    session: null,
  });

  useEffect(() => {
    if (!opened) {
      return;
    }

    let cancelled = false;
    const preferredSessionId = preferredTerminalId ?? state.session?.id ?? null;
    setState((current) => ({ ...current, error: null, isLoading: true }));

    async function ensureSession() {
      const existing = await api.listTerminalSessions();
      return ensureTerminalSession(api, existing, preferredSessionId, reuseRunning, createRequest);
    }

    ensureSession()
      .then((session) => {
        if (!cancelled) {
          setState({ error: null, isLoading: false, session });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            error: errorMessageFrom(error),
            isLoading: false,
            session: null,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, createRequest.command, createRequest.cwd, createRequest.projectId, createRequest.title, opened, preferredTerminalId, reuseRunning]);

  const createNewSession = useCallback(async () => {
    const currentTerminalId = state.session?.id ?? null;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      if (currentTerminalId) {
        await deleteKnownSession(api, currentTerminalId);
      }
      const session = await api.createTerminalSession(createRequest);
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
      }));
    }
  }, [api, createRequest, state.session?.id]);

  const stopSession = useCallback(async () => {
    const terminalId = state.session?.id;
    if (!terminalId) {
      return;
    }
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      await deleteKnownSession(api, terminalId);
      setState({ error: null, isLoading: false, session: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
      }));
    }
  }, [api, state.session?.id]);

  const recoverSession = useCallback(async () => {
    setState((current) => ({ ...current, error: null, isLoading: true, session: null }));
    try {
      const existing = await api.listTerminalSessions();
      const session = await ensureTerminalSession(api, existing, preferredTerminalId, reuseRunning, createRequest);
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
        session: null,
      }));
    }
  }, [api, createRequest, preferredTerminalId, reuseRunning]);

  return {
    ...state,
    createNewSession,
    recoverSession,
    stopSession,
  };
}

async function ensureTerminalSession(
  api: GatewayClient,
  existing: TerminalSessionInfo[],
  preferredTerminalId: string | null,
  reuseRunning: boolean,
  createRequest: CreateTerminalSession,
) {
  const preferredSession =
    preferredTerminalId
      ? existing.find((session) => session.id === preferredTerminalId && session.status === "running")
      : null;
  const reusableSession = reuseRunning ? existing.find((session) => session.status === "running") ?? null : null;
  return preferredSession ?? reusableSession ?? api.createTerminalSession(createRequest);
}

async function deleteKnownSession(api: GatewayClient, terminalId: string) {
  try {
    await api.deleteTerminalSession(terminalId);
  } catch (error) {
    if (!errorMessageFrom(error).includes("was not found")) {
      throw error;
    }
  }
}
