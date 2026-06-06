import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { applyKodexColorScheme, createKodexMantineTheme, getKodexColorScheme, type KodexColorSchemeId } from "../theme";
import { ThemeWorkbench } from "./ThemeWorkbench";

function renderWorkbench(initialSchemeId: KodexColorSchemeId = "oled-black") {
  const initialScheme = getKodexColorScheme(initialSchemeId);
  applyKodexColorScheme(document.documentElement, initialScheme);

  return render(
    <MantineProvider forceColorScheme={initialScheme.mode} theme={createKodexMantineTheme(initialScheme)}>
      <ThemeWorkbench initialColorSchemeId={initialScheme.id} />
    </MantineProvider>,
  );
}

describe("ThemeWorkbench", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-kodex-color-scheme");
    document.documentElement.removeAttribute("data-mantine-color-scheme");
    document.documentElement.removeAttribute("style");
  });

  it("renders plain Mantine controls in the theme workbench", async () => {
    renderWorkbench();

    expect(screen.getByRole("main", { name: /theme workbench/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Plain text input")).toBeInTheDocument();
    expect(screen.getByLabelText("Plain textarea")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Plain select" })).toBeInTheDocument();
    expect(screen.getByLabelText("Plain checkbox")).toBeInTheDocument();
    expect(screen.getByLabelText("Plain switch")).toBeInTheDocument();
    expect(screen.getByLabelText("Allow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /plain action/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /default button/i })).toBeInTheDocument();
    expect(screen.getByText("Neutral badge")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Themed tooltip")).toBeInTheDocument();
    expect(screen.getByLabelText("Plain progress")).toBeInTheDocument();
    expect(screen.getByLabelText("Plain skeleton")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(await screen.findByText("Archive")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /plain combobox/i }));
    expect(await screen.findByText("Pinned")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open popover/i }));
    expect(await screen.findByText("Popover surface uses default chrome.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(await screen.findByRole("dialog", { name: /themed modal/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open drawer/i }));
    expect(await screen.findByRole("dialog", { name: /themed drawer/i })).toBeInTheDocument();
  });

  it("shows disabled shared button controls", () => {
    renderWorkbench();

    expect(screen.getByRole("button", { name: /disabled button/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /disabled action/i })).toBeDisabled();
  });

  it("switches Kodex and Mantine color scheme attributes from the workbench", async () => {
    renderWorkbench();

    const colorSchemeGroup = screen.getByRole("radiogroup", { name: /color scheme/i });
    await userEvent.click(within(colorSchemeGroup).getByRole("radio", { name: /paper light/i }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");
      expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    });
    expect(window.localStorage.getItem("kodex-color-scheme")).toBe("paper-light");
  });
});
