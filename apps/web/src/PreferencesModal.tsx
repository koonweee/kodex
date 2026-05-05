import { Box, Modal, Stack, Text } from "@mantine/core";
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { KODEX_COLOR_SCHEMES, type KodexColorSchemeId } from "./theme";

type PreferenceSection = "appearance";

type PreferencesModalProps = {
  activeSection?: PreferenceSection;
  colorSchemeId: KodexColorSchemeId;
  onClose: () => void;
  onColorSchemeChange: (colorSchemeId: KodexColorSchemeId) => void;
  onSectionChange: (section: PreferenceSection) => void;
  opened: boolean;
};

export function PreferencesModal({
  activeSection = "appearance",
  colorSchemeId,
  onClose,
  onColorSchemeChange,
  onSectionChange,
  opened,
}: PreferencesModalProps) {
  const optionRefs = useRef<Partial<Record<KodexColorSchemeId, HTMLButtonElement | null>>>({});

  function handleSchemeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % KODEX_COLOR_SCHEMES.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + KODEX_COLOR_SCHEMES.length) % KODEX_COLOR_SCHEMES.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = KODEX_COLOR_SCHEMES.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextScheme = KODEX_COLOR_SCHEMES[nextIndex];
    onColorSchemeChange(nextScheme.id);
    optionRefs.current[nextScheme.id]?.focus();
  }

  return (
    <Modal
      centered
      classNames={{
        body: "kodex-preferences-modal-body",
        content: "kodex-preferences-modal-content",
        header: "kodex-preferences-modal-header",
      }}
      onClose={onClose}
      opened={opened}
      size={640}
      title="Preferences"
    >
      <Box className="kodex-preferences-layout">
        <Stack className="kodex-preferences-sections" gap={4}>
          <button
            className="kodex-ui-button kodex-ui-selectable kodex-preferences-section-button"
            data-active={activeSection === "appearance" ? "true" : undefined}
            onClick={() => onSectionChange("appearance")}
            type="button"
          >
            Appearance
          </button>
        </Stack>

        <Stack className="kodex-preferences-panel" gap={14}>
          <Text className="kodex-preferences-panel-title" fw={650}>
            Appearance
          </Text>

          <Stack className="kodex-preferences-setting" gap={8}>
            <Box className="kodex-preferences-setting-header">
              <Text fw={600} id="kodex-color-scheme-label" size="sm">
                Color scheme
              </Text>
            </Box>

            <Box aria-labelledby="kodex-color-scheme-label" className="kodex-scheme-list" role="radiogroup">
              {KODEX_COLOR_SCHEMES.map((scheme, index) => (
                <button
                  aria-checked={scheme.id === colorSchemeId}
                  className="kodex-ui-button kodex-ui-selectable kodex-scheme-option"
                  data-active={scheme.id === colorSchemeId ? "true" : undefined}
                  key={scheme.id}
                  onClick={() => onColorSchemeChange(scheme.id)}
                  onKeyDown={(event) => handleSchemeKeyDown(event, index)}
                  ref={(node) => {
                    optionRefs.current[scheme.id] = node;
                  }}
                  role="radio"
                  tabIndex={scheme.id === colorSchemeId ? 0 : -1}
                  type="button"
                >
                  <Box className="kodex-scheme-copy">
                    <Text className="kodex-scheme-label" fw={600}>
                      {scheme.label}
                    </Text>
                  </Box>
                  <Box aria-hidden="true" className="kodex-scheme-swatches">
                    {scheme.swatches.map((color) => (
                      <span className="kodex-scheme-swatch" key={color} style={{ background: color }} />
                    ))}
                  </Box>
                </button>
              ))}
            </Box>
          </Stack>
        </Stack>
      </Box>
    </Modal>
  );
}
