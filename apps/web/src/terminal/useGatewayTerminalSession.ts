import { useCallback, useEffect, useState } from "react";

import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  type CreateTerminalSession,
  type TerminalSessionInfo,
} from "../api/client";
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
      const existing = await listTerminalSessions();
      return ensureTerminalSession(existing, preferredSessionId, reuseRunning, createRequest);
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
  }, [createRequest.command, createRequest.cwd, createRequest.title, opened, preferredTerminalId, reuseRunning]);

  const createNewSession = useCallback(async () => {
    const currentTerminalId = state.session?.id ?? null;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      if (currentTerminalId) {
        await deleteKnownSession(currentTerminalId);
      }
      const session = await createTerminalSession(createRequest);
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
      }));
    }
  }, [createRequest, state.session?.id]);

  const stopSession = useCallback(async () => {
    const terminalId = state.session?.id;
    if (!terminalId) {
      return;
    }
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      await deleteTerminalSession(terminalId);
      setState({ error: null, isLoading: false, session: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
      }));
    }
  }, [state.session?.id]);

  const recoverSession = useCallback(async () => {
    setState((current) => ({ ...current, error: null, isLoading: true, session: null }));
    try {
      const existing = await listTerminalSessions();
      const session = await ensureTerminalSession(existing, preferredTerminalId, reuseRunning, createRequest);
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
        session: null,
      }));
    }
  }, [createRequest, preferredTerminalId, reuseRunning]);

  return {
    ...state,
    createNewSession,
    recoverSession,
    stopSession,
  };
}

async function ensureTerminalSession(
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
  return preferredSession ?? reusableSession ?? createTerminalSession(createRequest);
}

async function deleteKnownSession(terminalId: string) {
  try {
    await deleteTerminalSession(terminalId);
  } catch (error) {
    if (!errorMessageFrom(error).includes("was not found")) {
      throw error;
    }
  }
}
