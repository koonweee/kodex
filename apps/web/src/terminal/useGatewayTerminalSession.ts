import { useEffect, useState } from "react";

import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  type TerminalSessionInfo,
} from "../api/client";
import { errorMessageFrom } from "../shared/values";

type GatewayTerminalSessionState = {
  error: string | null;
  isLoading: boolean;
  session: TerminalSessionInfo | null;
};

export function useGatewayTerminalSession(opened: boolean) {
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
    const preferredSessionId = state.session?.id ?? null;
    setState((current) => ({ ...current, error: null, isLoading: true }));

    async function ensureSession() {
      const existing = await listTerminalSessions();
      const runningSession =
        existing.find((session) => session.id === preferredSessionId && session.status === "running") ??
        existing.find((session) => session.status === "running") ??
        null;
      return runningSession ?? createTerminalSession();
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
  }, [opened]);

  async function createNewSession() {
    const currentTerminalId = state.session?.id ?? null;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      if (currentTerminalId) {
        await deleteKnownSession(currentTerminalId);
      }
      const session = await createTerminalSession();
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
      }));
    }
  }

  async function stopSession() {
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
  }

  async function recoverSession() {
    setState((current) => ({ ...current, error: null, isLoading: true, session: null }));
    try {
      const existing = await listTerminalSessions();
      const session = existing.find((terminal) => terminal.status === "running") ?? (await createTerminalSession());
      setState({ error: null, isLoading: false, session });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessageFrom(error),
        isLoading: false,
        session: null,
      }));
    }
  }

  return {
    ...state,
    createNewSession,
    recoverSession,
    stopSession,
  };
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
