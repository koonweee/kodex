import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Menu, Stack } from "@mantine/core";
import { Bug, Check, CircleUserRound, Clock, LogIn, LogOut, Palette, Terminal } from "lucide-react";
import { useState } from "react";

import type { AccountResponse } from "../api/client";
import type { PreferenceSection } from "../PreferencesModal";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { CheckboxMenuItem } from "../ui/CheckboxMenuItem";
import type { UsageLimitLines } from "./rateLimits";
import { DeviceCodeLoginDialog } from "./DeviceCodeLoginDialog";
import { useDeviceCodeLogin } from "./useDeviceCodeLogin";

const ACCOUNT_TEXT = {
  debugEvents: "Show debug events",
  commandOutputs: "Show command outputs",
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
  onShowCommandOutputsChange,
  showDebugEvents,
  showCommandOutputs = false,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  onLogout: () => void;
  onSelectAutomations: () => void;
  onOpenPreferences: (section?: PreferenceSection) => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onShowCommandOutputsChange?: (value: boolean) => void;
  showDebugEvents: boolean;
  showCommandOutputs?: boolean;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const loginFlow = useDeviceCodeLogin(account);
  return (
    <>
      <SettingsMenu
        accountEmail={account?.account?.email ?? null}
        isAuthenticated={Boolean(account?.account)}
        onLogin={loginFlow.start}
        onLogout={onLogout}
        onSelectAutomations={onSelectAutomations}
        onOpenPreferences={onOpenPreferences}
        onShowDebugEventsChange={onShowDebugEventsChange}
        showDebugEvents={showDebugEvents}
        onShowCommandOutputsChange={onShowCommandOutputsChange}
        showCommandOutputs={showCommandOutputs}
        usageLimitLines={usageLimitLines}
      />
      <DeviceCodeLoginDialog flow={loginFlow} />
    </>
  );
}

function SettingsMenu({
  accountEmail,
  onLogin,
  isAuthenticated,
  onLogout,
  onSelectAutomations,
  onOpenPreferences,
  onShowDebugEventsChange,
  onShowCommandOutputsChange,
  showDebugEvents,
  showCommandOutputs = false,
  usageLimitLines,
}: {
  accountEmail: string | null;
  onLogin: () => void;
  isAuthenticated: boolean;
  onLogout: () => void;
  onSelectAutomations: () => void;
  onOpenPreferences: (section?: PreferenceSection) => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onShowCommandOutputsChange?: (value: boolean) => void;
  showDebugEvents: boolean;
  showCommandOutputs?: boolean;
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
          <Menu.Item
            aria-label="Usage details"
            className="kodex-settings-usage-limits"
            data-testid="sidebar-usage-limits"
            onClick={() => {
              setOpened(false);
              onOpenPreferences("usage");
            }}
          >
            <Stack gap={2}>
            {usageLimitLines.primary ? <span><AnimatedNumericText text={usageLimitLines.primary} /></span> : null}
            {usageLimitLines.secondary ? <span><AnimatedNumericText text={usageLimitLines.secondary} /></span> : null}
            {usageLimitLines.credits ? <span><AnimatedNumericText text={usageLimitLines.credits} /></span> : null}
            </Stack>
          </Menu.Item>
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

function accountInitialFromEmail(email: string | null): string | null {
  const trimmedEmail = email?.trim();
  if (!trimmedEmail) {
    return null;
  }
  return trimmedEmail[0]?.toUpperCase() ?? null;
}
