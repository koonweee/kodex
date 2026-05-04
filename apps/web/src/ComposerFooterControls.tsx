import { ActionIcon, Box, Button, Group, Menu, Switch, Text, Tooltip } from "@mantine/core";
import { AlertCircle, Check, Gauge, Shield } from "lucide-react";
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
  contextTokens?: number | null;
  modelContextWindow?: number | null;
};

type ComposerFooterControlsProps = {
  contextUsage?: ContextUsage | null;
  disabled?: boolean;
  models: ModelSummary[];
  showContextUsage?: boolean;
  settingsError?: string | null;
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
  showContextUsage = true,
  settingsError,
  settings,
  onSettingsChange,
}: ComposerFooterControlsProps) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0] ?? null;
  const selectedModel = models.find((model) => model.id === settings.model) ?? defaultModel;
  const selectedModelLabel = modelFullLabel(selectedModel);
  const selectedModelShortLabel = modelShortLabel(selectedModel);
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
      <Group className="kodex-composer-footer-left" gap={6} wrap="nowrap">
        <Menu position="top-start" withinPortal onClose={() => setConfirmingFullAccess(false)}>
          <Menu.Target>
            <Button
              aria-label={`Permissions: ${permissionLabel}`}
              className="kodex-composer-control"
              disabled={disabled}
              leftSection={<Shield size={14} />}
              size="compact-sm"
              type="button"
              variant="subtle"
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
                data-active={settings.permissionPreset === preset.id ? "true" : undefined}
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

        {settingsError ? (
          <Tooltip label={settingsError}>
            <ActionIcon aria-label={settingsError} color="red" size="md" type="button" variant="subtle">
              <AlertCircle size={15} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>

      <Group className="kodex-composer-footer-right" gap={6} wrap="nowrap">
        {showContextUsage ? <ContextUsageIndicator usage={contextUsage} /> : null}
        {settings.fast ? (
          <Tooltip label="Fast responses enabled">
            <Box aria-label="Fast responses enabled" className="kodex-composer-fast-indicator" component="span" role="img">
              <SolidBoltIcon />
            </Box>
          </Tooltip>
        ) : null}

        <Menu position="top-start" withinPortal>
          <Menu.Target>
            <Button
              aria-label={`Model: ${selectedModelLabel}${selectedEffort ? `, ${selectedEffort}` : ""}`}
              className="kodex-composer-control kodex-composer-model-control"
              disabled={disabled || models.length === 0}
              size="compact-sm"
              type="button"
              variant="subtle"
            >
              <span className="kodex-composer-model-name">{selectedModelShortLabel}</span>
              {selectedEffort ? (
                <>
                  {" "}
                  <span className="kodex-composer-model-effort">{reasoningEffortLabel(selectedEffort)}</span>
                </>
              ) : null}
            </Button>
          </Menu.Target>
          <Menu.Dropdown aria-label="Model and speed controls" className="kodex-composer-menu">
            <Menu.Label>Model</Menu.Label>
            {models.map((model) => (
              <Menu.Item
                key={model.id}
                data-active={selectedModel?.id === model.id ? "true" : undefined}
                leftSection={selectedModel?.id === model.id ? <Check size={14} /> : undefined}
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
                {model.model}
              </Menu.Item>
            ))}
            {supportedEfforts.length > 0 ? (
              <>
                <Menu.Divider />
                <Menu.Label>Reasoning</Menu.Label>
                {supportedEfforts.map((effort) => (
                  <Menu.Item
                    key={effort.reasoningEffort}
                    data-active={selectedEffort === effort.reasoningEffort ? "true" : undefined}
                    leftSection={selectedEffort === effort.reasoningEffort ? <Check size={14} /> : <Gauge size={14} />}
                    onClick={() => updateSettings({ model: selectedModel?.id, effort: effort.reasoningEffort })}
                  >
                    {reasoningEffortLabel(effort.reasoningEffort)}
                  </Menu.Item>
                ))}
              </>
            ) : null}
            <Menu.Divider />
            <Menu.Item
              className="kodex-composer-fast-row"
              closeMenuOnClick={false}
              component="div"
              leftSection={<SolidBoltIcon />}
              rightSection={
                <Switch
                  aria-label="Fast responses"
                  checked={settings.fast}
                  onChange={(event) => updateSettings({ fast: event.currentTarget.checked })}
                  onClick={(event) => event.stopPropagation()}
                  size="xs"
                />
              }
            >
              Fast
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Group>
  );
}

const CONTEXT_USAGE_BASELINE_TOKENS = 12_000;

function ContextUsageIndicator({ usage }: { usage?: ContextUsage | null }) {
  const used = usage?.contextTokens ?? null;
  const windowSize = usage?.modelContextWindow ?? null;
  const hasWindow = typeof used === "number" && typeof windowSize === "number" && windowSize > 0;
  const percentLeft = hasWindow ? contextPercentLeft(used, windowSize) : null;
  const percentUsed = percentLeft === null ? 0 : 100 - percentLeft;
  const usedLabel = typeof used === "number" ? used.toLocaleString() : null;
  const label =
    percentLeft !== null && usedLabel
      ? `${percentLeft}% context left. ${usedLabel} context tokens in use.`
      : usedLabel
        ? `${usedLabel} context tokens in use. Context window unavailable.`
        : "Context usage unavailable";

  return (
    <Tooltip label={label}>
      <Box
        component="span"
        aria-label={label}
        className="kodex-context-usage"
        data-known={hasWindow ? "true" : "false"}
        role="img"
        style={{ "--context-used": `${percentUsed}%` } as CSSProperties}
      >
        <span aria-hidden="true" />
      </Box>
    </Tooltip>
  );
}

function modelFullLabel(model: ModelSummary | null) {
  return model?.model || model?.displayName || model?.id || "Model";
}

function modelShortLabel(model: ModelSummary | null) {
  const label = modelFullLabel(model);
  return label.replace(/^gpt-/i, "");
}

function reasoningEffortLabel(value: string) {
  if (value.toLowerCase() === "xhigh") {
    return "xHigh";
  }
  return titleCase(value);
}

function contextPercentLeft(usedTokens: number, contextWindow: number) {
  if (contextWindow <= CONTEXT_USAGE_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = contextWindow - CONTEXT_USAGE_BASELINE_TOKENS;
  const effectiveUsed = Math.max(0, usedTokens - CONTEXT_USAGE_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - effectiveUsed);
  return Math.round(Math.min(100, Math.max(0, (remaining / effectiveWindow) * 100)));
}

function titleCase(value: string) {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function SolidBoltIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 24 24" width="14">
      <path d="M13 2 3 14h7l-1 8 12-14h-7z" />
    </svg>
  );
}
