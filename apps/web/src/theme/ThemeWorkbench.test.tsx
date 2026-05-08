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

  it("renders plain Mantine controls with Kodex theme component classes", async () => {
    renderWorkbench();

    expect(screen.getByRole("main", { name: /theme workbench/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Plain text input")).toHaveClass("kodex-mantine-input");
    expect(screen.getByLabelText("Plain textarea")).toHaveClass("kodex-mantine-input");
    expect(screen.getByRole("textbox", { name: "Plain select" })).toHaveClass("kodex-mantine-input");
    expect(screen.getByLabelText("Plain number input")).toHaveClass("kodex-mantine-input");

    expect(screen.getByRole("button", { name: /plain action/i })).toHaveClass("kodex-mantine-action-icon-root");
    expect(screen.getByRole("button", { name: /default button/i })).toHaveClass("kodex-mantine-button-root");
    expect(screen.getByText("Neutral badge").closest(".kodex-mantine-badge-root")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /activity/i })).toHaveClass("kodex-mantine-tabs-tab");
    expect(screen.getByText("Preview").closest("label")).toHaveClass("kodex-mantine-segmented-control-label");
    expect(screen.getByRole("alert")).toHaveClass("kodex-mantine-alert-root");

    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(await screen.findByRole("menu")).toHaveClass("kodex-mantine-menu-dropdown");
    expect((await screen.findByText("Archive")).closest(".kodex-mantine-menu-item")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open modal/i }));
    expect(await screen.findByRole("dialog", { name: /themed modal/i })).toHaveClass("kodex-mantine-modal-content");

    await userEvent.click(screen.getByRole("button", { name: /open drawer/i }));
    expect(await screen.findByRole("dialog", { name: /themed drawer/i })).toHaveClass("kodex-mantine-drawer-content");
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
