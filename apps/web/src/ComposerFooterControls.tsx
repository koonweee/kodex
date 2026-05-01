import { ActionIcon, Box, Button, Group, Menu, Text, Tooltip } from "@mantine/core";
import { Brain, Check, Gauge, Shield, Zap } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

import type { ModelSummary } from "./api/client";

export type PermissionPresetId = "default" | "autoReview" | "fullAccess";

export type ComposerSettings = {
  model?: string;
  effort?: string;
  fast: boolean;
  permissionPreset?: PermissionPresetId;
};

export type ContextUsage = {
  totalTokens?: number | null;
  modelContextWindow?: number | null;
};

type ComposerFooterControlsProps = {
  contextUsage?: ContextUsage | null;
  disabled?: boolean;
  models: ModelSummary[];
  settings: ComposerSettings;
  onSettingsChange: (settings: ComposerSettings) => void;
};

const PERMISSION_PRESETS: Array<{
  id: PermissionPresetId;
  label: string;
  description: string;
  tone?: "danger";
}> = [
  {
    id: "default",
    label: "Default permissions",
    description: "Ask before sandbox escapes and write inside the workspace.",
  },
  {
    id: "autoReview",
    label: "Auto review",
    description: "Route approval decisions through the auto reviewer.",
  },
  {
    id: "fullAccess",
    label: "Full access",
    description: "Runs without sandbox restrictions on this local machine.",
    tone: "danger",
  },
];

export function ComposerFooterControls({
  contextUsage,
  disabled = false,
  models,
  settings,
  onSettingsChange,
}: ComposerFooterControlsProps) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0] ?? null;
  const selectedModel = models.find((model) => model.id === settings.model) ?? defaultModel;
  const selectedModelLabel = selectedModel?.displayName || selectedModel?.model || selectedModel?.id || "Model";
  const selectedEffort = settings.effort ?? selectedModel?.defaultReasoningEffort ?? null;
  const selectedPermission = PERMISSION_PRESETS.find((preset) => preset.id === settings.permissionPreset);
  const permissionLabel = selectedPermission?.label ?? "Default permissions";
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);

  function updateSettings(next: Partial<ComposerSettings>) {
    onSettingsChange({ ...settings, ...next });
  }

  function selectPermissionPreset(preset: PermissionPresetId) {
    if (preset !== "fullAccess") {
      setConfirmingFullAccess(false);
      updateSettings({ permissionPreset: preset });
      return;
    }

    if (!confirmingFullAccess) {
      setConfirmingFullAccess(true);
      return;
    }

    setConfirmingFullAccess(false);
    updateSettings({ permissionPreset: preset });
  }

  return (
    <Group className="kodex-composer-footer-controls" gap={6} wrap="nowrap">
      <Menu position="top-start" withinPortal onClose={() => setConfirmingFullAccess(false)}>
        <Menu.Target>
          <Button
            aria-label={`Permissions: ${permissionLabel}`}
            className="kodex-composer-control"
            disabled={disabled}
            leftSection={<Shield size={14} />}
            size="compact-sm"
            type="button"
            variant={settings.permissionPreset ? "light" : "subtle"}
          >
            {permissionLabel}
          </Button>
        </Menu.Target>
        <Menu.Dropdown aria-label="Permissions presets" className="kodex-composer-menu">
          {PERMISSION_PRESETS.map((preset) => (
            <Menu.Item
              key={preset.id}
              closeMenuOnClick={preset.id !== "fullAccess" || confirmingFullAccess}
              color={preset.tone === "danger" ? "red" : undefined}
              leftSection={settings.permissionPreset === preset.id ? <Check size={14} /> : <Shield size={14} />}
              onClick={() => selectPermissionPreset(preset.id)}
            >
              <Box className="kodex-composer-menu-item">
                <Text size="sm" fw={600}>
                  {preset.id === "fullAccess" && confirmingFullAccess ? "Confirm full access" : preset.label}
                </Text>
                <Text size="xs" c={preset.tone === "danger" ? "red.3" : "dimmed"}>
                  {preset.id === "fullAccess" && confirmingFullAccess
                    ? "Click again to run without sandbox restrictions."
                    : preset.description}
                </Text>
              </Box>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      <ContextUsageIndicator usage={contextUsage} />

      <Menu position="top-start" withinPortal>
        <Menu.Target>
          <Button
            aria-label={`Model: ${selectedModelLabel}${selectedEffort ? `, ${selectedEffort}` : ""}`}
            className="kodex-composer-control"
            disabled={disabled || models.length === 0}
            leftSection={settings.fast ? <Zap size={14} fill="currentColor" /> : <Brain size={14} />}
            size="compact-sm"
            type="button"
            variant={settings.model || settings.effort || settings.fast ? "light" : "subtle"}
          >
            {selectedModelLabel}
            {selectedEffort ? ` ${titleCase(selectedEffort)}` : ""}
          </Button>
        </Menu.Target>
        <Menu.Dropdown aria-label="Model and speed controls" className="kodex-composer-menu">
          <Menu.Label>Model</Menu.Label>
          {models.map((model) => (
            <Menu.Item
              key={model.id}
              leftSection={selectedModel?.id === model.id ? <Check size={14} /> : <Brain size={14} />}
              onClick={() =>
                updateSettings({
                  model: model.id,
                  effort: model.supportedReasoningEfforts.some(
                    (effort) => effort.reasoningEffort === settings.effort,
                  )
                    ? settings.effort
                    : undefined,
                })
              }
            >
              {model.displayName || model.model || model.id}
            </Menu.Item>
          ))}
          {supportedEfforts.length > 0 ? (
            <>
              <Menu.Divider />
              <Menu.Label>Reasoning</Menu.Label>
              {supportedEfforts.map((effort) => (
                <Menu.Item
                  key={effort.reasoningEffort}
                  leftSection={selectedEffort === effort.reasoningEffort ? <Check size={14} /> : <Gauge size={14} />}
                  onClick={() => updateSettings({ model: selectedModel?.id, effort: effort.reasoningEffort })}
                >
                  <Box className="kodex-composer-menu-item">
                    <Text size="sm" fw={600}>
                      {titleCase(effort.reasoningEffort)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {effort.description}
                    </Text>
                  </Box>
                </Menu.Item>
              ))}
            </>
          ) : null}
          <Menu.Divider />
          <Menu.Item
            leftSection={settings.fast ? <Check size={14} /> : <Zap size={14} />}
            onClick={() => updateSettings({ fast: !settings.fast })}
          >
            Fast
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function ContextUsageIndicator({ usage }: { usage?: ContextUsage | null }) {
  const used = usage?.totalTokens ?? null;
  const windowSize = usage?.modelContextWindow ?? null;
  const hasWindow = typeof used === "number" && typeof windowSize === "number" && windowSize > 0;
  const percentUsed = hasWindow ? Math.min(100, Math.max(0, (used / windowSize) * 100)) : 0;
  const percentLeft = hasWindow ? Math.max(0, Math.round(100 - percentUsed)) : null;
  const label = hasWindow
    ? `${percentLeft}% context left. ${used.toLocaleString()} of ${windowSize.toLocaleString()} tokens used.`
    : "Context usage unavailable";

  return (
    <Tooltip label={label}>
      <ActionIcon
        aria-label={label}
        className="kodex-context-usage"
        data-known={hasWindow ? "true" : "false"}
        size="md"
        type="button"
        variant="subtle"
        style={{ "--context-used": `${percentUsed}%` } as CSSProperties}
      >
        <span aria-hidden="true" />
      </ActionIcon>
    </Tooltip>
  );
}

function titleCase(value: string) {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}
