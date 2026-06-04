import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Text, Tooltip } from "@mantine/core";
import { Plus, Square, X } from "lucide-react";
import { useCallback, useState } from "react";

import { terminalWebSocketUrl } from "../api/client";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { XtermTerminal, type TerminalConnectionState, type TerminalInputSignal } from "./XtermTerminal";
import { useGatewayTerminalSession } from "./useGatewayTerminalSession";

type GatewayTerminalHostProps = {
  onClose: () => void;
  opened: boolean;
};

const TERMINAL_TEXT = {
  close: "Close terminal",
  create: "New terminal",
  fallbackTitle: "Terminal",
  loading: "Starting terminal",
  reconnect: "Reconnect terminal",
  stop: "Stop terminal",
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

export function GatewayTerminalHost({ onClose, opened }: GatewayTerminalHostProps) {
  const { createNewSession, error, isLoading, recoverSession, session, stopSession } = useGatewayTerminalSession(opened);
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("closed");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [inputSignal, setInputSignal] = useState<TerminalInputSignal | null>(null);
  const { hasTouchInput } = useInputCapabilities();
  const handleConnectionStateChange = useCallback((state: TerminalConnectionState) => {
    setConnectionState(state);
    if (state === "open" || state === "connecting") {
      setConnectionMessage(null);
      return;
    }
    if (opened && session && !isLoading) {
      setConnectionMessage(state === "error" ? "Terminal connection failed." : "Terminal connection closed.");
    }
  }, [isLoading, opened, session]);

  if (!opened) {
    return null;
  }

  const status = connectionState === "open" && session?.status === "running" ? "connected" : session?.status ?? connectionState;
  const actionSize = hasTouchInput ? "lg" : "sm";
  const terminalError = error ?? connectionMessage;

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

  async function handleReconnect() {
    setConnectionMessage(null);
    setConnectionState("connecting");
    await recoverSession();
  }

  return (
    <Box aria-label="Gateway terminal" className="kodex-terminal-host" role="dialog">
      <Group className="kodex-terminal-header" justify="space-between" wrap="nowrap">
        <Box className="kodex-terminal-heading">
          <Group gap="xs" wrap="nowrap">
            <Text className="kodex-terminal-title">{session?.title ?? TERMINAL_TEXT.fallbackTitle}</Text>
            <Badge className="kodex-terminal-status" color={status === "connected" ? "green" : "gray"} size="xs" variant="light">
              {status}
            </Badge>
          </Group>
          {session?.cwd ? <Text className="kodex-terminal-cwd">{session.cwd}</Text> : null}
        </Box>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={TERMINAL_TEXT.create}>
            <ActionIcon
              aria-label={TERMINAL_TEXT.create}
              color="gray"
              disabled={isLoading}
              onClick={createNewSession}
              size={actionSize}
              type="button"
              variant="subtle"
            >
              <Plus size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={TERMINAL_TEXT.stop}>
            <ActionIcon
              aria-label={TERMINAL_TEXT.stop}
              color="gray"
              disabled={!session || isLoading}
              onClick={stopSession}
              size={actionSize}
              type="button"
              variant="subtle"
            >
              <Square size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={TERMINAL_TEXT.close}>
            <ActionIcon
              aria-label={TERMINAL_TEXT.close}
              color="gray"
              onClick={onClose}
              size={actionSize}
              type="button"
              variant="subtle"
            >
              <X size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {terminalError ? (
        <Alert color="red" className="kodex-terminal-error">
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <Text size="sm">{terminalError}</Text>
            {connectionMessage ? (
              <Button onClick={handleReconnect} size="xs" type="button" variant="light">
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
