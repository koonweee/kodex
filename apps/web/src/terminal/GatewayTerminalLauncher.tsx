import { ActionIcon, Tooltip } from "@mantine/core";
import { SquareTerminal } from "lucide-react";

type GatewayTerminalLauncherProps = {
  disabled?: boolean;
  onOpen: () => void;
  size?: "xs" | "sm" | "md";
};

const TERMINAL_LABEL = "Open terminal";

export function GatewayTerminalLauncher({ disabled, onOpen, size = "xs" }: GatewayTerminalLauncherProps) {
  return (
    <Tooltip label={TERMINAL_LABEL}>
      <ActionIcon
        aria-label={TERMINAL_LABEL}
        className="kodex-terminal-launcher"
        color="gray"
        disabled={disabled}
        onClick={onOpen}
        size={size}
        type="button"
        variant="subtle"
      >
        <SquareTerminal size={size === "md" ? 17 : 14} />
      </ActionIcon>
    </Tooltip>
  );
}
