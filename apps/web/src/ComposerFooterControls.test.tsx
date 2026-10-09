import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerFooterControls, type ComposerSettings } from "./ComposerFooterControls";
import type { ModelSummary } from "./api/client";

const paneLayout = vi.hoisted(() => ({ compact: false, short: false }));
vi.mock("./shared/PaneLayout", () => ({ usePaneLayout: () => paneLayout }));
beforeEach(() => { paneLayout.compact = false; });

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
  it("removes its portalled menu when its pane becomes inactive", async () => {
    const onMenuOpenChange = vi.fn();
    const controls = (disabled: boolean) => (
      <ComposerFooterControls disabled={disabled} models={[reasoningModel]} settings={settings}
        onSettingsChange={vi.fn()} onMenuOpenChange={onMenuOpenChange} />
    );
    const { rerender } = renderWithProvider(controls(false));
    await userEvent.click(screen.getByRole("button", { name: "Model: gpt-5.4, medium" }));
    expect(await screen.findByRole("menu", { hidden: true })).toBeInTheDocument();

    rerender(<MantineProvider>{controls(true)}</MantineProvider>);
    expect(screen.getByRole("menu", { hidden: true })).not.toBeVisible();
    await waitFor(() => expect(onMenuOpenChange).toHaveBeenLastCalledWith(false));
  });

  it("reports menu opening and closing after selection and keyboard dismissal", async () => {
    const focusAtClose: (Element | null)[] = [];
    const onMenuOpenChange = vi.fn((opened: boolean) => {
      if (!opened) focusAtClose.push(document.activeElement);
    });
    renderWithProvider(<ComposerFooterControls models={[reasoningModel]} settings={settings} onSettingsChange={vi.fn()} onMenuOpenChange={onMenuOpenChange} />);
    const trigger = screen.getByRole("button", { name: "Model: gpt-5.4, medium" });
    await userEvent.click(trigger);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reasoning", hidden: true }));
    await userEvent.click(screen.getByRole("menuitem", { name: "High", hidden: true }));
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    expect(focusAtClose.at(-1)).toBe(trigger);
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.keyboard("{Escape}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    expect(focusAtClose.at(-1)).toBe(trigger);
    expect(trigger).toHaveFocus();
  });


  it.each([false, true])("exposes the menu relationship on the trigger in compact=%s panes", async (compact) => {
    paneLayout.compact = compact;
    renderWithProvider(<ComposerFooterControls models={[reasoningModel]} settings={settings} onSettingsChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Model: gpt-5.4, medium" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = await screen.findByRole("menu", { hidden: true });
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(document.getElementById(trigger.getAttribute("aria-controls")!)).toBe(menu);
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("retains the focused model trigger as its pane switches between text and icon presentation", () => {
    const controls = () => <ComposerFooterControls models={[reasoningModel]} settings={settings} onSettingsChange={vi.fn()} />;
    const { rerender } = renderWithProvider(controls());
    const trigger = screen.getByRole("button", { name: "Model: gpt-5.4, medium" });
    trigger.focus();
    expect(trigger).toHaveTextContent("5.4 Medium");

    paneLayout.compact = true;
    rerender(<MantineProvider>{controls()}</MantineProvider>);
    expect(screen.getByRole("button", { name: "Model: gpt-5.4, medium" })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent(/^$/);

    paneLayout.compact = false;
    rerender(<MantineProvider>{controls()}</MantineProvider>);
    expect(screen.getByRole("button", { name: "Model: gpt-5.4, medium" })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("5.4 Medium");
  });

  it("exposes the complete compact picker selection in its tooltip and menu without disrupting submenu focus on resize", async () => {
    paneLayout.compact = true;
    const fullModel = { ...reasoningModel, id: "native-model-with-a-long-name", model: "native-model-with-a-long-name" };
    const controls = () => <ComposerFooterControls models={[fullModel]} settings={{ model: fullModel.id, effort: "medium", fast: false }} onSettingsChange={vi.fn()} />;
    const { rerender } = renderWithProvider(controls());
    const trigger = screen.getByRole("button", { name: `Model: ${fullModel.model}, medium` });
    await userEvent.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(`Model: ${fullModel.model}, medium`);
    await userEvent.unhover(trigger);
    await userEvent.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "Model", hidden: true })).toHaveTextContent(fullModel.model);
    const reasoning = screen.getByRole("menuitem", { name: "Reasoning", hidden: true });
    expect(reasoning).toHaveTextContent("Medium");
    reasoning.focus();
    await userEvent.keyboard("{ArrowRight}");
    const medium = screen.getByRole("menuitem", { name: "Medium", hidden: true });
    expect(medium).toHaveFocus();

    paneLayout.compact = false;
    rerender(<MantineProvider>{controls()}</MantineProvider>);
    expect(medium).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
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
