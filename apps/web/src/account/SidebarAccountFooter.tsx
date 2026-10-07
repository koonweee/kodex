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
        usageLimitLines={usageLimitLines}
      />
      <DeviceCodeLoginDialog flow={loginFlow} />
    </>
  );
}
