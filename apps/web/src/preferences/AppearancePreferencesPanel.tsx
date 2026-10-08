import { Box, Button, Group, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import { Check } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import type { AppearanceMode, AppearancePreferences, AppearanceThemeMode } from "../theme/appearancePreferences";
import { KODEX_COLOR_SCHEMES, type KodexColorSchemeId } from "../themeRegistry";
import { useInterfacePreferences } from "./useInterfacePreferences";

export type AppearancePreferencesPanelProps = {
  preferences: AppearancePreferences;
  resolvedSchemeId: KodexColorSchemeId;
  onModeChange: (mode: AppearanceMode) => void;
  onThemeChange: (id: KodexColorSchemeId) => void;
};

export function AppearancePreferencesPanel({ preferences, resolvedSchemeId, onModeChange, onThemeChange }: AppearancePreferencesPanelProps) {
  const { preferences: interfacePreferences, setFullscreenComposerOnTouch } = useInterfacePreferences();
  const activeScheme = KODEX_COLOR_SCHEMES.find((scheme) => scheme.id === resolvedSchemeId)!;
  const [browseMode, setBrowseMode] = useState<AppearanceThemeMode>(activeScheme.mode);
  const optionRefs = useRef<Partial<Record<KodexColorSchemeId, HTMLButtonElement | null>>>({});
  const schemes = KODEX_COLOR_SCHEMES.filter((scheme) => scheme.mode === browseMode);
  const selectedId = browseMode === "light" ? preferences.lightThemeId : preferences.darkThemeId;
  const themeLabel = browseMode === "light" ? "Light theme" : "Dark theme";

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight": nextIndex = (index + 1) % schemes.length; break;
      case "ArrowUp":
      case "ArrowLeft": nextIndex = (index - 1 + schemes.length) % schemes.length; break;
      case "Home": nextIndex = 0; break;
      case "End": nextIndex = schemes.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const nextScheme = schemes[nextIndex];
    onThemeChange(nextScheme.id);
    optionRefs.current[nextScheme.id]?.focus();
  }

  return (
    <Stack className="kodex-preferences-panel kodex-appearance-panel" gap={14}>
      <Text className="kodex-preferences-panel-title" fw={650}>Interface</Text>
      <Stack className="kodex-preferences-setting" gap={6}>
        <Text fw={600} id="kodex-appearance-mode-label" size="sm">Appearance mode</Text>
        <SegmentedControl
          aria-labelledby="kodex-appearance-mode-label"
          className="kodex-appearance-mode"
          data={[{ label: "Auto", value: "auto" }, { label: "Light", value: "light" }, { label: "Dark", value: "dark" }]}
          onChange={(mode) => onModeChange(mode as AppearanceMode)}
          value={preferences.mode}
        />
        <Text c="dimmed" size="xs">Auto follows your system appearance using your selected light and dark themes.</Text>
        <Text c="dimmed" size="xs" aria-live="polite">Currently using {activeScheme.label}.</Text>
      </Stack>
      <Stack className="kodex-preferences-setting" gap={6}>
        <Text fw={600} size="sm">Composer</Text>
        <Switch
          checked={interfacePreferences.fullscreenComposerOnTouch}
          label="Open composer fullscreen when using touch"
          onChange={(event) => setFullscreenComposerOnTouch(event.currentTarget.checked)}
        />
        <Text c="dimmed" size="xs">Mouse and keyboard activation always stays inline.</Text>
      </Stack>
      <Stack className="kodex-preferences-setting" gap={8}>
        <Group className="kodex-appearance-browse-header" justify="space-between" gap={8}>
          <Text fw={600} size="sm">Themes</Text>
          <SegmentedControl
            aria-label="Browse themes"
            data={[{ label: "Light", value: "light" }, { label: "Dark", value: "dark" }]}
            onChange={(mode) => setBrowseMode(mode as AppearanceThemeMode)}
            size="xs"
            value={browseMode}
          />
        </Group>
        <Text c="dimmed" size="xs">Choose a theme for each appearance. Browsing or selecting a theme keeps your mode.</Text>
        <Box aria-label={themeLabel} className="kodex-scheme-list" role="radiogroup">
          {schemes.map((scheme, index) => {
            const selected = scheme.id === selectedId;
            const tokens = scheme.rootVariables;
            return (
              <Button
                aria-checked={selected}
                aria-label={scheme.label}
                className="kodex-scheme-option"
                data-active={selected ? "true" : undefined}
                key={scheme.id}
                onClick={() => onThemeChange(scheme.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                ref={(node) => { optionRefs.current[scheme.id] = node; }}
                role="radio"
                tabIndex={selected ? 0 : -1}
                title={scheme.description}
                type="button"
                variant={selected ? "light" : "default"}
              >
                <Box className="kodex-scheme-card-content">
                  {/* Palette previews deliberately show the candidate's semantic pairs, independent of the active theme. */}
                  <Box aria-hidden="true" className="kodex-scheme-preview" style={{ background: tokens["--kodex-bg-thread-surface"], color: tokens["--kodex-text-primary"], borderColor: tokens["--kodex-border-subtle"] }}>
                    <span className="kodex-scheme-preview-sidebar" style={{ background: tokens["--kodex-bg-shell"], borderColor: tokens["--kodex-border-subtle"] }} />
                    <Box className="kodex-scheme-preview-body">
                      <span className="kodex-scheme-preview-heading">Aa</span>
                      <span className="kodex-scheme-preview-line" style={{ background: tokens["--kodex-text-secondary"] }} />
                      <span className="kodex-scheme-preview-action" style={{ background: tokens["--kodex-bg-action"], color: tokens["--kodex-text-on-action"] }}>Action</span>
                    </Box>
                  </Box>
                  <Box className="kodex-scheme-copy">
                    <Text className="kodex-scheme-label" fw={600}>{scheme.label}</Text>
                    {selected ? <Check aria-hidden="true" className="kodex-scheme-selected" size={14} /> : null}
                  </Box>
                  <Box aria-hidden="true" className="kodex-scheme-swatches">
                    {scheme.swatches.map((color, swatchIndex) => <span className="kodex-scheme-swatch" key={swatchIndex} style={{ background: color }} />)}
                  </Box>
                </Box>
              </Button>
            );
          })}
        </Box>
      </Stack>
    </Stack>
  );
}
