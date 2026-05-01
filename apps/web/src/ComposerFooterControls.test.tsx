import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ComposerFooterControls, type ComposerSettings } from "./ComposerFooterControls";
import type { ModelSummary } from "./api/client";

const model: ModelSummary = {
  id: "gpt-5.4",
  model: "gpt-5.4",
  displayName: "GPT-5.4",
  description: "General coding model",
  defaultReasoningEffort: "medium",
  hidden: false,
  inputModalities: ["text"],
  isDefault: true,
  rawPayload: {},
  supportedReasoningEfforts: [],
  upgrade: null,
};

const settings: ComposerSettings = {
  fast: false,
};

describe("ComposerFooterControls", () => {
  it("requires a second confirmation click before applying full access", async () => {
    const onSettingsChange = vi.fn();

    renderWithProvider(
      <ComposerFooterControls models={[model]} settings={settings} onSettingsChange={onSettingsChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/full access/i);

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /permissions: default permissions/i })).toBeInTheDocument();

    await clickMenuItem(/confirm full access/i);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith({ fast: false, permissionPreset: "fullAccess" });
  });

  it("applies ordinary permission presets with one click", async () => {
    const onSettingsChange = vi.fn();

    renderWithProvider(
      <ComposerFooterControls models={[model]} settings={settings} onSettingsChange={onSettingsChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/default permissions/i);

    expect(onSettingsChange).toHaveBeenCalledWith({ fast: false, permissionPreset: "default" });

    onSettingsChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/auto review/i);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith({ fast: false, permissionPreset: "autoReview" });
  });
});

function renderWithProvider(element: ReactElement) {
  return render(<MantineProvider>{element}</MantineProvider>);
}

async function clickMenuItem(name: RegExp) {
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = screen.queryAllByRole("menuitem", { hidden: true }).find((element) => name.test(element.textContent ?? ""));
    expect(item).toBeInTheDocument();
  });
  await userEvent.click(item!);
}
