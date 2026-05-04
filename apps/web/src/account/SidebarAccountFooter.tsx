import { ActionIcon, Box, Button, Group, Tooltip } from "@mantine/core";
import { LogIn, Settings } from "lucide-react";
import { useState } from "react";

import type { AccountResponse } from "../api/client";
import type { UsageLimitLines } from "./rateLimits";

export type LoginState = {
  authUrl?: string | null;
  loginId?: string | null;
};

const ACCOUNT_TEXT = {
  cancel: "Cancel login",
  connect: "Connect ChatGPT",
  debugEvents: "Show debug events",
  logout: "Logout",
  open: "Open ChatGPT auth",
  preferences: "Preferences",
  settings: "Account settings",
};

export function SidebarAccountFooter({
  account,
  loginState,
  onCancelLogin,
  onLogin,
  onLogout,
  onOpenPreferences,
  onShowDebugEventsChange,
  showDebugEvents,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  loginState: LoginState;
  onCancelLogin: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const accountLabel = account?.account?.email ?? account?.account?.accountType ?? ACCOUNT_TEXT.connect;

  return (
    <Group className="kodex-sidebar-footer" justify="space-between" gap="sm" wrap="nowrap">
      <Group gap="xs" wrap="nowrap" className="kodex-account-summary">
        {account?.account ? (
          <Tooltip label={accountLabel}>
            <Box aria-label={accountLabel} className="kodex-account-avatar" role="img">
              {accountInitial(accountLabel)}
            </Box>
          </Tooltip>
        ) : (
          <Button className="kodex-account-primary" leftSection={<LogIn size={14} />} size="xs" variant="light" onClick={onLogin}>
            {ACCOUNT_TEXT.connect}
          </Button>
        )}
        {!account?.account && loginState.authUrl ? (
          <Button
            className="kodex-account-secondary"
            component="a"
            href={loginState.authUrl}
            target="_blank"
            rel="noreferrer"
            size="xs"
            variant="subtle"
          >
            {ACCOUNT_TEXT.open}
          </Button>
        ) : null}
        {!account?.account && loginState.loginId ? (
          <Button className="kodex-account-secondary" size="xs" variant="subtle" color="gray" onClick={onCancelLogin}>
            {ACCOUNT_TEXT.cancel}
          </Button>
        ) : null}
      </Group>
      <SettingsMenu
        isAuthenticated={Boolean(account?.account)}
        onLogout={onLogout}
        onOpenPreferences={onOpenPreferences}
        onShowDebugEventsChange={onShowDebugEventsChange}
        showDebugEvents={showDebugEvents}
        usageLimitLines={usageLimitLines}
      />
    </Group>
  );
}

function SettingsMenu({
  isAuthenticated,
  onLogout,
  onOpenPreferences,
  onShowDebugEventsChange,
  showDebugEvents,
  usageLimitLines,
}: {
  isAuthenticated: boolean;
  onLogout: () => void;
  onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <Box className="kodex-settings-menu">
      <ActionIcon
        aria-label={ACCOUNT_TEXT.settings}
        aria-expanded={opened}
        className="kodex-settings-button"
        variant="subtle"
        onClick={() => setOpened((current) => !current)}
      >
        <Settings size={17} />
      </ActionIcon>
      {opened ? (
        <Box className="kodex-settings-dropdown" role="menu">
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
          <button
            className="kodex-settings-menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpened(false);
              onOpenPreferences();
            }}
          >
            {ACCOUNT_TEXT.preferences}
          </button>
          {isAuthenticated ? (
            <button
              className="kodex-settings-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpened(false);
                onLogout();
              }}
            >
              {ACCOUNT_TEXT.logout}
            </button>
          ) : null}
          <button
            className="kodex-debug-toggle"
            type="button"
            role="menuitemcheckbox"
            aria-checked={showDebugEvents}
            onClick={() => onShowDebugEventsChange(!showDebugEvents)}
          >
            {ACCOUNT_TEXT.debugEvents}
          </button>
        </Box>
      ) : null}
    </Box>
  );
}

function accountInitial(label: string): string {
  return (label.trim().charAt(0) || "?").toUpperCase();
}
