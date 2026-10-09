import { Box, Menu } from "@mantine/core";
import { Bug, Check, CircleUserRound, Clock, LogIn, LogOut, Palette, Terminal } from "lucide-react";
import { useState } from "react";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { CheckboxMenuItem } from "../ui/CheckboxMenuItem";
import type { UsageLimitLines } from "./rateLimits";

const ACCOUNT_TEXT = {
  debugEvents: "Show debug events",
  commandOutputs: "Show command outputs",
  automations: "Automations",
  logout: "Logout",
  preferences: "Preferences",
  settings: "Account settings",
};

export function SettingsMenu({
  accountLabel,
  onLogin,
  isAuthenticated,
  onLogout,
  logoutPending = false,
  onSelectAutomations,
  onOpenPreferences,
  onShowDebugEventsChange,
  onShowCommandOutputsChange,
  showDebugEvents,
  showCommandOutputs = false,
  usageLimitLines,
}: {
  accountLabel: string | null;
  onLogin: () => void;
  isAuthenticated: boolean;
  onLogout: () => void;
  logoutPending?: boolean;
  onSelectAutomations: () => void;
  onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onShowCommandOutputsChange?: (value: boolean) => void;
  showDebugEvents: boolean;
  showCommandOutputs?: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [opened, setOpened] = useState(false);
  const accountInitial = accountInitialFromLabel(accountLabel);

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal={false}>
      <Menu.Target>
        <AdaptiveIconButton
          className="kodex-account-menu-trigger"
          label={ACCOUNT_TEXT.settings}
          tooltip={false}

        >
          {accountInitial ? (
            <span className="kodex-account-menu-avatar" title={accountLabel ?? undefined}>{accountInitial}</span>
          ) : (
            <CircleUserRound size={16} />
          )}
        </AdaptiveIconButton>
      </Menu.Target>
      <Menu.Dropdown aria-label={ACCOUNT_TEXT.settings} className="kodex-settings-dropdown">
        {usageLimitLines ? (
          <Box
            aria-label="Usage limits"
            className="kodex-settings-usage-limits"
            data-testid="sidebar-usage-limits"
            role="presentation"
          >
            <span>{usageLimitLines.primary}</span>
            {usageLimitLines.secondary ? <span>{usageLimitLines.secondary}</span> : null}
          </Box>
        ) : null}
        <Menu.Item
          className="kodex-settings-menu-item"
          leftSection={<Clock size={14} />}
          onClick={() => {
            setOpened(false);
            onSelectAutomations();
          }}
        >
          {ACCOUNT_TEXT.automations}
        </Menu.Item>
        <Menu.Item
          className="kodex-settings-menu-item"
          leftSection={<Palette size={14} />}
          onClick={() => {
            setOpened(false);
            onOpenPreferences();
          }}
        >
          {ACCOUNT_TEXT.preferences}
        </Menu.Item>
        {isAuthenticated ? (
          <Menu.Item
            className="kodex-settings-menu-item"
            leftSection={<LogOut size={14} />}
            disabled={logoutPending}
            onClick={() => {
              setOpened(false);
              onLogout();
            }}
          >
            {ACCOUNT_TEXT.logout}
          </Menu.Item>
        ) : (
          <Menu.Item
            className="kodex-settings-menu-item"
            leftSection={<LogIn size={14} />}
            onClick={() => {
              setOpened(false);
              onLogin();
            }}
          >
            Sign in with ChatGPT
          </Menu.Item>
        )}
        <CheckboxMenuItem
          checked={showDebugEvents}
          className="kodex-debug-toggle"
          leftSection={showDebugEvents ? <Check size={14} /> : <Bug size={14} />}
          onChange={onShowDebugEventsChange}
        >
          {ACCOUNT_TEXT.debugEvents}
        </CheckboxMenuItem>
        <CheckboxMenuItem
          checked={showCommandOutputs}
          leftSection={showCommandOutputs ? <Check size={14} /> : <Terminal size={14} />}
          onChange={(value) => onShowCommandOutputsChange?.(value)}
        >
          {ACCOUNT_TEXT.commandOutputs}
        </CheckboxMenuItem>
      </Menu.Dropdown>
    </Menu>
  );
}

function accountInitialFromLabel(label: string | null): string | null {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel) {
    return null;
  }
  return trimmedLabel[0]?.toUpperCase() ?? null;
}
