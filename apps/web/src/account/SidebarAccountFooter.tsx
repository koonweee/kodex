import type { AccountResponse } from "../api/client";
import type { UsageLimitLines } from "./rateLimits";
import { SettingsMenu } from "./SettingsMenu";
import { DeviceCodeLoginDialog } from "./DeviceCodeLoginDialog";
import { useDeviceCodeLogin } from "./useDeviceCodeLogin";

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
  onOpenPreferences: () => void;
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
        accountLabel={account?.account?.email ?? null}
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
