import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppearancePreferencesPanel } from "./AppearancePreferencesPanel";
import type { AppearancePreferences } from "../theme/appearancePreferences";
import { KODEX_COLOR_SCHEMES } from "../themeRegistry";
import { INTERFACE_PREFERENCES_STORAGE_KEY, readStoredInterfacePreferences } from "./useInterfacePreferences";

function mountPanel() {
  const onModeChange = vi.fn();
  const onThemeChange = vi.fn();
  function Harness() {
    const [preferences, setPreferences] = useState<AppearancePreferences>({ mode: "auto", lightThemeId: "paper-light", darkThemeId: "oled-black" });
    return <AppearancePreferencesPanel
      preferences={preferences}
      resolvedSchemeId={preferences.mode === "light" ? preferences.lightThemeId : preferences.darkThemeId}
      onModeChange={(mode) => { onModeChange(mode); setPreferences((value) => ({ ...value, mode })); }}
      onThemeChange={(id) => { onThemeChange(id); setPreferences((value) => KODEX_COLOR_SCHEMES.find((scheme) => scheme.id === id)?.mode === "light" ? { ...value, lightThemeId: id } : { ...value, darkThemeId: id }); }}
    />;
  }
  render(<MantineProvider env="test"><Harness /></MantineProvider>);
  return { onModeChange, onThemeChange };
}

describe("AppearancePreferencesPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    readStoredInterfacePreferences(true);
  });

  it("stores the device fullscreen preference from the Interface panel", async () => {
    mountPanel();
    const toggle = screen.getByRole("switch", { name: "Open composer fullscreen when using touch" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(JSON.parse(window.localStorage.getItem(INTERFACE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      fullscreenComposerOnTouch: false,
      autoUpdatePwa: false,
    });
  });

  it("stores auto update in Interface preferences and restores it when reopened", async () => {
    mountPanel();
    const toggle = screen.getByRole("switch", { name: "Auto-update" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(readStoredInterfacePreferences()).toEqual({ fullscreenComposerOnTouch: true, autoUpdatePwa: true });
    cleanup();
    mountPanel();
    expect(screen.getByRole("switch", { name: "Auto-update" })).toBeChecked();
  });

  it("browses light and dark choices without changing appearance mode or saved themes", async () => {
    const { onModeChange, onThemeChange } = mountPanel();
    const filter = screen.getByRole("radiogroup", { name: "Browse themes" });
    const cards = screen.getByRole("radiogroup", { name: "Dark theme" });
    expect(within(cards).getAllByRole("radio")).toHaveLength(KODEX_COLOR_SCHEMES.filter((scheme) => scheme.mode === "dark").length);
    expect(within(cards).getByRole("radio", { name: "OLED Black" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(filter).getByRole("radio", { name: "Light" }));
    const lightCards = screen.getByRole("radiogroup", { name: "Light theme" });
    expect(within(lightCards).getAllByRole("radio")).toHaveLength(KODEX_COLOR_SCHEMES.filter((scheme) => scheme.mode === "light").length);
    expect(within(lightCards).getByRole("radio", { name: "Paper Light" })).toHaveAttribute("aria-checked", "true");
    expect(onModeChange).not.toHaveBeenCalled();
    expect(onThemeChange).not.toHaveBeenCalled();
  });

  it("saves an inactive theme while preserving the selected appearance mode", async () => {
    const { onModeChange, onThemeChange } = mountPanel();
    const mode = screen.getByRole("radiogroup", { name: "Appearance mode" });
    await userEvent.click(within(mode).getByRole("radio", { name: "Light" }));
    expect(onModeChange).toHaveBeenLastCalledWith("light");
    await userEvent.click(screen.getByRole("radio", { name: "Dracula" }));
    expect(onThemeChange).toHaveBeenLastCalledWith("dracula");
    expect(within(mode).getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByText("Currently using Paper Light.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dracula" })).toHaveAttribute("aria-checked", "true");
  });

  it("uses arrow, Home and End keys only among the browsed themes", async () => {
    const { onThemeChange } = mountPanel();
    screen.getByRole("radio", { name: "OLED Black" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Dracula" })).toHaveFocus();
    expect(onThemeChange).toHaveBeenLastCalledWith("dracula");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("radio", { name: KODEX_COLOR_SCHEMES.filter((scheme) => scheme.mode === "dark").at(-1)!.label })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "OLED Black" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(onThemeChange).toHaveBeenLastCalledWith("oled-black");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Browse themes" })).getByRole("radio", { name: "Light" }));
    screen.getByRole("radio", { name: "Paper Light" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    const lightNext = KODEX_COLOR_SCHEMES.filter((scheme) => scheme.mode === "light")[1] ?? KODEX_COLOR_SCHEMES.find((scheme) => scheme.id === "paper-light")!;
    expect(screen.getByRole("radio", { name: lightNext.label })).toHaveFocus();
    expect(onThemeChange).toHaveBeenLastCalledWith(lightNext.id);
  });
});
