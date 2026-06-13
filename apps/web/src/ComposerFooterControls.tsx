import { Box, Button, Group, Menu, Switch, Text, Tooltip } from "@mantine/core";
import { AlertCircle, Check, Gauge, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

import type { ModelSummary } from "./api/client";
import { AdaptiveIconButton } from "./ui/AdaptiveIconButton";
import { CheckboxMenuItem } from "./ui/CheckboxMenuItem";

export type ComposerSettings = {
  model?: string;
  effort?: string;
  fast: boolean;
  serviceTier?: string | null;
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
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const [modelMenuOpened, setModelMenuOpened] = useState(false);

  function updateSettings(next: Partial<ComposerSettings>) {
    onSettingsChange({ ...settings, ...next });
  }

  function toggleFast(checked: boolean) {
    updateSettings({ fast: checked, serviceTier: checked ? "fast" : null });
    setModelMenuOpened(false);
  }

  return (
    <Group className="kodex-composer-footer-controls" gap={6} wrap="nowrap">
      <Group className="kodex-composer-footer-left" gap={6} wrap="nowrap">
        {settingsError ? (
          <AdaptiveIconButton color="red" label={settingsError}>
            <AlertCircle />
          </AdaptiveIconButton>
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

        <Menu position="top-start" withinPortal opened={modelMenuOpened} onChange={setModelMenuOpened}>
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
          <Menu.Dropdown aria-label="Model and speed controls" className="kodex-composer-menu kodex-run-settings-menu">
            <MobileMenuHeader title="Run settings" onClose={() => setModelMenuOpened(false)} />
            <Menu.Label>Model</Menu.Label>
            <Box className="kodex-run-settings-chip-row" data-section="model">
              {models.map((model) => (
                <Menu.Item
                  className="kodex-run-settings-chip"
                  key={model.id}
                  data-active={selectedModel?.id === model.id ? "true" : undefined}
                  leftSection={selectedModel?.id === model.id ? <Check size={14} /> : undefined}
                  onClick={() => {
                    updateSettings({
                      model: model.id,
                      effort: model.supportedReasoningEfforts.some(
                        (effort) => effort.reasoningEffort === settings.effort,
                      )
                        ? settings.effort
                        : undefined,
                    });
                    setModelMenuOpened(false);
                  }}
                >
                  {model.model}
                </Menu.Item>
              ))}
            </Box>
            {supportedEfforts.length > 0 ? (
              <>
                <Menu.Divider />
                <Menu.Label>Reasoning</Menu.Label>
                <Box className="kodex-run-settings-chip-row" data-section="reasoning">
                  {supportedEfforts.map((effort) => (
                    <Menu.Item
                      className="kodex-run-settings-chip"
                      key={effort.reasoningEffort}
                      data-active={selectedEffort === effort.reasoningEffort ? "true" : undefined}
                      leftSection={selectedEffort === effort.reasoningEffort ? <Check size={14} /> : <Gauge size={14} />}
                      onClick={() => {
                        updateSettings({ model: selectedModel?.id, effort: effort.reasoningEffort });
                        setModelMenuOpened(false);
                      }}
                    >
                      {reasoningEffortLabel(effort.reasoningEffort)}
                    </Menu.Item>
                  ))}
                </Box>
              </>
            ) : null}
            <Menu.Divider />
            <CheckboxMenuItem
              checked={settings.fast}
              className="kodex-composer-fast-row"
              leftSection={<SolidBoltIcon />}
              onChange={toggleFast}
              rightSection={<Switch aria-hidden="true" checked={settings.fast} readOnly size="xs" tabIndex={-1} />}
            >
              Fast
            </CheckboxMenuItem>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Group>
  );
}

function MobileMenuHeader({ onClose, title }: { onClose: () => void; title: string }) {
  return (
    <Group className="kodex-run-settings-header" justify="space-between" wrap="nowrap">
      <Text fw={700} size="sm">
        {title}
      </Text>
      <AdaptiveIconButton label={`Close ${title}`} onClick={onClose}>
        <X />
      </AdaptiveIconButton>
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
