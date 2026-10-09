import { Box, Button, Modal, Stack } from "@mantine/core";
import type { ReactNode } from "react";

import { McpPreferencesPanel } from "./mcp/McpPreferencesPanel";
import { useNotificationsPreferencesPanel } from "./preferences/NotificationsPreferencesPanel";
import { usePluginsPreferencesPanel } from "./preferences/PluginsPreferencesPanel";
import { ExecutionPreferencesPanel } from "./preferences/ExecutionPreferencesPanel";
import { AppearancePreferencesPanel } from "./preferences/AppearancePreferencesPanel";
import type { AppearanceMode, AppearancePreferences } from "./theme/appearancePreferences";
import type { KodexColorSchemeId } from "./theme";

export type PreferenceSection = "appearance" | "execution" | "notifications" | "plugins" | "mcp";

export type PreferencesModalProps = {
  activeSection?: PreferenceSection;
  preferences: AppearancePreferences;
  resolvedSchemeId: KodexColorSchemeId;
  onClose: () => void;
  onModeChange: (mode: AppearanceMode) => void;
  onThemeChange: (id: KodexColorSchemeId) => void;
  onSectionChange: (section: PreferenceSection) => void;
  opened: boolean;
  executionPanel?: ReactNode;
  mcpPanel?: ReactNode;
  pluginsPanel?: ReactNode;
  notificationsPanel?: ReactNode;
};

export function PreferencesModal({
  activeSection = "appearance",
  preferences,
  resolvedSchemeId,
  onClose,
  onModeChange,
  onThemeChange,
  onSectionChange,
  opened,
  executionPanel,
  mcpPanel,
  pluginsPanel,
  notificationsPanel,
}: PreferencesModalProps) {
  const defaultPluginsPanel = usePluginsPreferencesPanel(opened && activeSection === "plugins" && pluginsPanel == null);
  const defaultNotificationsPanel = useNotificationsPreferencesPanel(opened && activeSection === "notifications" && notificationsPanel == null);

  return (
    <Modal
      centered
      classNames={{
        body: "kodex-preferences-modal-body",
      }}
      onClose={onClose}
      opened={opened}
      size={640}
      title="Preferences"
    >
      <Box className="kodex-preferences-layout">
        <Stack className="kodex-preferences-sections" gap={4}>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "appearance" ? "true" : undefined}
            onClick={() => onSectionChange("appearance")}
            type="button"
            variant={activeSection === "appearance" ? "light" : "subtle"}
          >
            Interface
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "execution" ? "true" : undefined}
            onClick={() => onSectionChange("execution")}
            type="button"
            variant={activeSection === "execution" ? "light" : "subtle"}
          >
            Execution
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "notifications" ? "true" : undefined}
            onClick={() => onSectionChange("notifications")}
            type="button"
            variant={activeSection === "notifications" ? "light" : "subtle"}
          >
            Notifications
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "plugins" ? "true" : undefined}
            onClick={() => onSectionChange("plugins")}
            type="button"
            variant={activeSection === "plugins" ? "light" : "subtle"}
          >
            Plugins
          </Button>
          <Button
            className="kodex-preferences-section-button"
            data-active={activeSection === "mcp" ? "true" : undefined}
            onClick={() => onSectionChange("mcp")}
            type="button"
            variant={activeSection === "mcp" ? "light" : "subtle"}
          >
            MCP
          </Button>
        </Stack>

        {activeSection === "appearance" ? (
          <AppearancePreferencesPanel
            preferences={preferences}
            resolvedSchemeId={resolvedSchemeId}
            onModeChange={onModeChange}
            onThemeChange={onThemeChange}
          />
        ) : activeSection === "execution" ? (
          executionPanel ?? <ExecutionPreferencesPanel />
        ) : activeSection === "notifications" ? (
          notificationsPanel ?? defaultNotificationsPanel
        ) : activeSection === "plugins" ? (
          pluginsPanel ?? defaultPluginsPanel
        ) : (
          mcpPanel ?? <McpPreferencesPanel />
        )}
      </Box>
    </Modal>
  );
}
