import { ActionIcon, Alert, Box, Button, Group, Loader, Text, Tooltip } from "@mantine/core";
import { Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { terminalWebSocketUrl } from "../../api/client";
import { errorMessageFrom } from "../../shared/values";
import { useInputCapabilities } from "../../shared/inputCapabilities";
import {
  XtermTerminal,
  type TerminalConnectionState,
  type TerminalInputSignal,
} from "../../terminal/XtermTerminal";
import { useGatewayTerminalSession } from "../../terminal/useGatewayTerminalSession";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";

const TERMINAL_TEXT = {
  create: "New terminal",
  loading: "Starting terminal",
  reconnect: "Reconnect terminal",
};

const TERMINAL_ACCESSORY_KEYS: Array<{ data: string; label: string }> = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "Ctrl-C", data: "\x03" },
  { label: "Left", data: "\x1b[D" },
  { label: "Down", data: "\x1b[B" },
  { label: "Up", data: "\x1b[A" },
  { label: "Right", data: "\x1b[C" },
];

export function TerminalPane({ pane }: WorkspacePaneComponentProps) {
  const target = paneTargetRecord(pane);
  const { openTerminalPane, setPaneHeaderActions, setPaneTabStatus, updatePane } = useWorkspace();
  const targetTerminalId = typeof target.terminalId === "string" ? target.terminalId : null;
  const targetCwd = typeof target.cwd === "string" ? target.cwd : null;
  const targetCommand = typeof target.command === "string" ? target.command : null;
  const createRequest = useMemo(
    () => ({
      command: targetCommand ?? undefined,
      cwd: targetCwd ?? undefined,
      title: pane.title ?? undefined,
    }),
    [pane.title, targetCommand, targetCwd],
  );
  const { error, isLoading, recoverSession, session } = useGatewayTerminalSession(true, {
    createRequest,
    preferredTerminalId: targetTerminalId,
    reuseRunning: false,
  });
  const patchingSessionIdRef = useRef<string | null>(null);
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("closed");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [inputSignal, setInputSignal] = useState<TerminalInputSignal | null>(null);
  const [paneError, setPaneError] = useState<string | null>(null);
  const { hasTouchInput } = useInputCapabilities();

  useEffect(() => {
    if (!session || targetTerminalId === session.id || patchingSessionIdRef.current === session.id) {
      return;
    }
    patchingSessionIdRef.current = session.id;
    setPaneError(null);
    void updatePane(pane.id, {
      target: {
        ...target,
        command: targetCommand ?? session.command,
        cwd: targetCwd ?? session.cwd,
        terminalId: session.id,
      },
      title: pane.title ?? session.title,
    })
      .catch((updateError: unknown) => setPaneError(errorMessageFrom(updateError)))
      .finally(() => {
        if (patchingSessionIdRef.current === session.id) {
          patchingSessionIdRef.current = null;
        }
      });
  }, [pane.id, pane.title, session, target, targetCommand, targetCwd, targetTerminalId, updatePane]);

  const handleConnectionStateChange = useCallback((state: TerminalConnectionState) => {
    setConnectionState(state);
    if (state === "open" || state === "connecting") {
      setConnectionMessage(null);
      return;
    }
    if (session && !isLoading) {
      setConnectionMessage(state === "error" ? "Terminal connection failed." : "Terminal connection closed.");
    }
  }, [isLoading, session]);

  function sendAccessoryInput(data: string) {
    setInputSignal((current) => ({ data, id: (current?.id ?? 0) + 1 }));
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendAccessoryInput(text);
      }
    } catch {
      setConnectionMessage("Clipboard paste is unavailable.");
    }
  }

  const handleReconnect = useCallback(async () => {
    setConnectionMessage(null);
    setConnectionState("connecting");
    await recoverSession();
  }, [recoverSession]);

  const actionSize = hasTouchInput ? "lg" : "sm";
  const terminalError = paneError ?? error ?? connectionMessage;
  const tabStatus = terminalError
    ? "error"
    : connectionState === "open" && session?.status === "running"
      ? "connected"
      : connectionState === "connecting" || isLoading
        ? "connecting"
        : "closed";
  const handleOpenTerminalTab = useCallback(() => {
    void openTerminalPane({
      ...(targetCommand ? { command: targetCommand } : {}),
      ...(session?.cwd ?? targetCwd ? { cwd: session?.cwd ?? targetCwd } : {}),
      placement: { direction: "within", sourcePaneId: pane.id },
    });
  }, [openTerminalPane, pane.id, session?.cwd, targetCommand, targetCwd]);
  const paneHeaderActions = useMemo(
    () => (
      <Group className="kodex-terminal-pane-actions" gap={4} wrap="nowrap">
        <Tooltip label={TERMINAL_TEXT.create}>
          <ActionIcon
            aria-label={TERMINAL_TEXT.create}
            color="gray"
            disabled={isLoading}
            onClick={handleOpenTerminalTab}
            size={actionSize}
            type="button"
            variant="subtle"
          >
            <Plus size={16} />
          </ActionIcon>
        </Tooltip>
        {connectionMessage ? (
          <Tooltip label={TERMINAL_TEXT.reconnect}>
            <ActionIcon
              aria-label={TERMINAL_TEXT.reconnect}
              color="gray"
              disabled={isLoading}
              onClick={() => void handleReconnect()}
              size={actionSize}
              type="button"
              variant="subtle"
            >
              <RotateCw size={15} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
    ),
    [actionSize, connectionMessage, handleOpenTerminalTab, handleReconnect, isLoading],
  );

  useEffect(() => {
    setPaneHeaderActions(pane.id, paneHeaderActions);
    return () => setPaneHeaderActions(pane.id, null);
  }, [pane.id, paneHeaderActions, setPaneHeaderActions]);

  useEffect(() => {
    setPaneTabStatus(pane.id, tabStatus);
    return () => setPaneTabStatus(pane.id, null);
  }, [pane.id, setPaneTabStatus, tabStatus]);

  return (
    <Box aria-label="Terminal pane" className="kodex-terminal-host kodex-terminal-pane" role="region">
      {terminalError ? (
        <Alert className="kodex-terminal-error" color="red">
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <Text size="sm">{terminalError}</Text>
            {connectionMessage ? (
              <Button
                className="kodex-terminal-reconnect-button"
                leftSection={<RotateCw size={13} />}
                onClick={handleReconnect}
                size="xs"
                type="button"
                variant="light"
              >
                {TERMINAL_TEXT.reconnect}
              </Button>
            ) : null}
          </Group>
        </Alert>
      ) : null}
      <Group className="kodex-terminal-accessory-row" gap={4} wrap="nowrap">
        {TERMINAL_ACCESSORY_KEYS.map((key) => (
          <button className="kodex-terminal-accessory-key" key={key.label} onClick={() => sendAccessoryInput(key.data)} type="button">
            {key.label}
          </button>
        ))}
        <button className="kodex-terminal-accessory-key" onClick={handlePaste} type="button">
          Paste
        </button>
      </Group>
      <Box className="kodex-terminal-body">
        {isLoading && !session ? (
          <Group className="kodex-terminal-loading" gap="xs" justify="center">
            <Loader size="sm" />
            <Text>{TERMINAL_TEXT.loading}</Text>
          </Group>
        ) : session ? (
          <XtermTerminal
            className="kodex-terminal-viewport"
            inputSignal={inputSignal}
            onConnectionStateChange={handleConnectionStateChange}
            webSocketUrl={terminalWebSocketUrl(session.id)}
          />
        ) : null}
      </Box>
    </Box>
  );
}
