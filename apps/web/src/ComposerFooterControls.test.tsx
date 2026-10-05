import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
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
  it.each([
    { label: "Fast", role: "menuitemcheckbox", submenu: null, expected: { fast: true, serviceTier: "fast" } },
    { label: "High", role: "menuitem", submenu: "Reasoning", expected: { effort: "high" } },
    { label: "gpt-5.4", role: "menuitem", submenu: "Model", expected: { model: model.id } },
  ])("emits only the $label intent instead of a stale complete settings form", async ({ label, role, submenu, expected }) => {
    const onSettingsChange = vi.fn();
    renderWithProvider(
      <ComposerFooterControls models={[reasoningModel]} settings={{ model: model.id, effort: "medium", fast: false }} onSettingsChange={onSettingsChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    if (submenu) {
      await userEvent.click(await screen.findByRole("menuitem", { name: submenu, hidden: true }));
    }
    await userEvent.click(await screen.findByRole(role, { name: label, hidden: true }));
    expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("supports keyboard submenu navigation, returns focus on Back, and reopens at root", async () => {
    const onSettingsChange = vi.fn();
    renderWithProvider(<ComposerFooterControls models={[reasoningModel]} settings={settings} onSettingsChange={onSettingsChange} />);
    const trigger = screen.getByRole("button", { name: /model: gpt-5\.4, medium/i });
    await userEvent.click(trigger);
    const reasoning = await screen.findByRole("menuitem", { name: "Reasoning", hidden: true });
    reasoning.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("aria-label", "Reasoning");
    expect(screen.getByRole("menuitem", { name: "Medium", hidden: true })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Reasoning", hidden: true })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ effort: "high" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Reasoning", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "High", hidden: true })).not.toBeInTheDocument();
  });

  it.each(["low", "medium"])("displays the advertised %s default without writing an override", async (effort) => {
    const onSettingsChange = vi.fn();
    renderWithProvider(<ComposerFooterControls models={[{ ...reasoningModel, defaultReasoningEffort: effort }]} settings={{ model: model.id, fast: false }} onSettingsChange={onSettingsChange} />);
    const label = effort === "low" ? "Low" : "Medium";
    const trigger = screen.getByRole("button", { name: `Model: gpt-5.4, ${effort}` });
    expect(trigger).toHaveTextContent(label);
    await userEvent.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "Reasoning", hidden: true })).toHaveTextContent(label);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("displays the actual native model when it is absent from the catalog", () => {
    renderWithProvider(
      <ComposerFooterControls models={[reasoningModel]} settings={{ model: "native-custom", effort: "ultra", fast: false }} onSettingsChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Model: native-custom, ultra" })).toHaveTextContent("native-custom Ultra");
  });

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

    expect(await screen.findByRole("menuitem", { name: "Model", hidden: true })).toHaveTextContent("gpt-5.4");
    expect(screen.getByRole("menuitem", { name: "Reasoning", hidden: true })).toHaveTextContent("Medium");
    expect(screen.queryByRole("menuitem", { name: /^gpt-5\.4$/i, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^xhigh$/i, hidden: true })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: "Model", hidden: true }));
    expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("aria-label", "Model");
    expect(screen.getByRole("menuitem", { name: /^gpt-5\.4$/i, hidden: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Back", hidden: true }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Reasoning", hidden: true }));
    expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("aria-label", "Reasoning");
    expect(screen.getByRole("menuitem", { name: /^xhigh$/i, hidden: true })).toHaveTextContent("xHigh");
    await userEvent.click(screen.getByRole("menuitem", { name: "Back", hidden: true }));

    const fastItem = screen.getByRole("menuitemcheckbox", { name: /fast/i, hidden: true });
    expect(fastItem).not.toHaveAttribute("data-disabled");
    expect(fastItem).toHaveAttribute("aria-checked", "false");
    fastItem.focus();
    expect(fastItem).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Reasoning", hidden: true })).toHaveFocus();
    fastItem.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSettingsChange).toHaveBeenCalledWith({ fast: true, serviceTier: "fast" });

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
    expect(screen.queryByRole("menu", { name: /permission profiles/i, hidden: true })).not.toBeInTheDocument();
  });
});

function renderWithProvider(element: ReactElement) {
  return render(<MantineProvider>{element}</MantineProvider>);
}
