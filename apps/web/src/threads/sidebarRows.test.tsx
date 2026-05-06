import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SidebarActionDisclosureRow, SidebarSectionDisclosureRow } from "./sidebarRows";

describe("sidebar row primitives", () => {
  it("renders a section disclosure row with shared regions and accessible collapse state", async () => {
    const onToggle = vi.fn();

    renderRow(<SidebarSectionDisclosureRow collapsed={false} label="Projects" onToggle={onToggle} />);

    const toggle = screen.getByRole("button", { name: "Collapse Projects section" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.closest(".kodex-sidebar-row")).toBeInTheDocument();
    expect(toggle.closest(".kodex-sidebar-row")).toHaveClass("kodex-sidebar-row");
    expect(toggle.closest(".kodex-sidebar-row")?.querySelector(".kodex-sidebar-row-label")).toHaveTextContent("Projects");
    expect(toggle.closest(".kodex-sidebar-row")?.querySelector(".kodex-sidebar-row-disclosure")).toBeInTheDocument();
    expect(toggle.closest(".kodex-sidebar-row")?.querySelector(".kodex-sidebar-row-trailing")).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps trailing section actions separate from disclosure toggles", async () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();

    renderRow(
      <SidebarSectionDisclosureRow
        collapsed={false}
        label="Projects"
        onToggle={onToggle}
        trailingActions={[{ icon: <Plus size={14} />, label: "Add project", onClick: onAdd }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders item rows with fixed leading and trailing rails", async () => {
    const onToggle = vi.fn();
    const onAction = vi.fn();

    renderRow(
      <SidebarActionDisclosureRow
        collapsed={true}
        disclosureLabel="Expand Project"
        label="Project"
        leadingIcon={<Folder size={15} />}
        onToggle={onToggle}
        trailingActions={[{ icon: <Plus size={14} />, label: "New thread", onClick: onAction }]}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Expand Project" });
    const row = toggle.closest(".kodex-sidebar-row");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(row?.querySelector(".kodex-sidebar-row-leading")).toBeInTheDocument();
    expect(row?.querySelector(".kodex-sidebar-row-trailing")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();

    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

function renderRow(row: ReactNode) {
  return render(<MantineProvider>{row}</MantineProvider>);
}
