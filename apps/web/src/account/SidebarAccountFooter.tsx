import { Box, Menu } from "@mantine/core";
import { Bug, Check, CircleUserRound, Clock, LogOut, Palette } from "lucide-react";
import { useState } from "react";

import type { AccountResponse } from "../api/client";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { CheckboxMenuItem } from "../ui/CheckboxMenuItem";
import type { UsageLimitLines } from "./rateLimits";

export type LoginState = {
  authUrl?: string | null;
  loginId?: string | null;
};

const ACCOUNT_TEXT = {
  debugEvents: "Show debug events",
  automations: "Automations",
  logout: "Logout",
  preferences: "Preferences",
  settings: "Account settings",
};

export function SidebarAccountMenu({
  account,
  onLogout,
  onSelectAutomations,
  onOpenPreferences,
  onShowDebugEventsChange,
  showDebugEvents,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  onLogout: () => void;
  onSelectAutomations: () => void;
  onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  return (
    <SettingsMenu
      accountEmail={account?.account?.email ?? null}
      isAuthenticated={Boolean(account?.account)}
      onLogout={onLogout}
      onSelectAutomations={onSelectAutomations}
      onOpenPreferences={onOpenPreferences}
      onShowDebugEventsChange={onShowDebugEventsChange}
      showDebugEvents={showDebugEvents}
      usageLimitLines={usageLimitLines}
    />
  );
}

function SettingsMenu({
  accountEmail,
  isAuthenticated,
  onLogout,
  onSelectAutomations,
  onOpenPreferences,
  onShowDebugEventsChange,
  showDebugEvents,
  usageLimitLines,
}: {
  accountEmail: string | null;
  isAuthenticated: boolean;
  onLogout: () => void;
  onSelectAutomations: () => void;
  onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [opened, setOpened] = useState(false);
  const accountInitial = accountInitialFromEmail(accountEmail);

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal={false}>
      <Menu.Target>
        <AdaptiveIconButton
          className="kodex-account-menu-trigger"
          label={ACCOUNT_TEXT.settings}
          tooltip={false}

        >
          {accountInitial ? (
            <span className="kodex-account-menu-avatar">{accountInitial}</span>
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
            onClick={() => {
              setOpened(false);
              onLogout();
            }}
          >
            {ACCOUNT_TEXT.logout}
          </Menu.Item>
        ) : null}
        <CheckboxMenuItem
          checked={showDebugEvents}
          className="kodex-debug-toggle"
          leftSection={showDebugEvents ? <Check size={14} /> : <Bug size={14} />}
          onChange={onShowDebugEventsChange}
        >
          {ACCOUNT_TEXT.debugEvents}
        </CheckboxMenuItem>
      </Menu.Dropdown>
    </Menu>
  );
}

function accountInitialFromEmail(email: string | null): string | null {
  const trimmedEmail = email?.trim();
  if (!trimmedEmail) {
    return null;
  }
  return trimmedEmail[0]?.toUpperCase() ?? null;
}
