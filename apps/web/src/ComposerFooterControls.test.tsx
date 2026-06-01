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

const reasoningModel: ModelSummary = {
  ...model,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
    { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
    { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  ],
};

const settings: ComposerSettings = {
  fast: false,
};

describe("ComposerFooterControls", () => {
  it("renders context usage as a non-interactive indicator and uses a compact model label", () => {
    renderWithProvider(
      <ComposerFooterControls
        contextUsage={{ contextTokens: 42_000, modelContextWindow: 200_000 }}
        models={[model]}
        settings={settings}
        onSettingsChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("img", { name: /context left/i })).toHaveClass("kodex-context-usage");
    expect(screen.queryByRole("button", { name: /context left/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i })).toHaveTextContent("5.4 Medium");
  });

  it("uses model ids in the menu, compact reasoning labels, and toggles Fast from the row", async () => {
    const onSettingsChange = vi.fn();
    const { rerender } = renderWithProvider(
      <ComposerFooterControls models={[reasoningModel]} settings={settings} onSettingsChange={onSettingsChange} />,
    );

    expect(screen.queryByRole("button", { name: /fast responses/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /fast responses enabled/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /^gpt-5\.4$/i, hidden: true })).toBeInTheDocument();
    });
    expect(screen.getByRole("menuitem", { name: /^xhigh$/i, hidden: true })).toHaveTextContent("xHigh");

    const fastItem = screen.getByRole("menuitemcheckbox", { name: /fast/i, hidden: true });
    expect(fastItem).not.toHaveAttribute("data-disabled");
    expect(fastItem).toHaveAttribute("aria-checked", "false");
    expect(fastItem).toHaveClass("kodex-composer-fast-row");
    fastItem.focus();
    expect(fastItem).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: /^xhigh$/i, hidden: true })).toHaveFocus();
    fastItem.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSettingsChange).toHaveBeenCalledWith({ fast: true });

    rerender(
      <MantineProvider>
        <ComposerFooterControls
          models={[reasoningModel]}
          settings={{ fast: true }}
          onSettingsChange={onSettingsChange}
        />
      </MantineProvider>,
    );
    expect(screen.getByRole("img", { name: /fast responses enabled/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fast responses/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    expect(screen.getByRole("menuitemcheckbox", { name: /fast/i, hidden: true })).toHaveAttribute("aria-checked", "true");
  });

  it("renders app-server permission profile metadata and selects a profile id", async () => {
    const onSettingsChange = vi.fn();

    renderWithProvider(
      <ComposerFooterControls
        models={[model]}
        permissionProfiles={[
          { id: ":workspace", label: "Workspace", description: "Ask before leaving the workspace" },
          { id: "full-access", label: "Full access", description: null },
        ]}
        settings={settings}
        onSettingsChange={onSettingsChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    expect(await screen.findByText("Ask before leaving the workspace")).toBeInTheDocument();
    await clickMenuItem(/workspace/i);

    expect(onSettingsChange).toHaveBeenCalledWith({ fast: false, permissionProfileId: ":workspace" });
  });

  it("falls back to profile ids and can clear to configured defaults", async () => {
    const onSettingsChange = vi.fn();

    renderWithProvider(
      <ComposerFooterControls
        models={[model]}
        permissionProfiles={[{ id: "custom-profile", label: "custom-profile", description: null }]}
        settings={{ fast: false, permissionProfileId: "custom-profile" }}
        onSettingsChange={onSettingsChange}
      />,
    );

    expect(screen.getByRole("button", { name: /permissions: custom-profile/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /permissions: custom-profile/i }));
    await clickMenuItem(/default permissions/i);

    expect(onSettingsChange).toHaveBeenCalledWith({ fast: false, permissionProfileId: undefined });
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
