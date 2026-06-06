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

    expect(screen.getByRole("img", { name: /context left/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /context left/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i })).toHaveTextContent("5.4 Medium");
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
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

  it("does not render execution permission controls in the composer", () => {
    renderWithProvider(
      <ComposerFooterControls models={[model]} settings={settings} onSettingsChange={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: /permission profiles/i })).not.toBeInTheDocument();
  });
});

function renderWithProvider(element: ReactElement) {
  return render(<MantineProvider>{element}</MantineProvider>);
}
