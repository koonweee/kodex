import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { QueueDisclosure } from "./QueueDisclosure";

const size = vi.hoisted(() => ({ short: false }));
vi.mock("../shared/PaneLayout", () => ({ usePaneLayout: () => ({ compact: false, short: size.short }) }));
function view(count: number, partial = false) {
  return <MantineProvider><QueueDisclosure count={count} partial={partial}><button>Queued action</button></QueueDisclosure></MantineProvider>;
}
it("collapses multiple messages, updates the count, and exposes a single remaining message", async () => {
  size.short = false;
  const { rerender } = render(view(2));
  await userEvent.click(screen.getByRole("button", { name: "Collapse queued messages" }));
  expect(screen.queryByRole("button", { name: "Queued action" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /2 queued messages/ })).toHaveFocus();
  rerender(view(3, true));
  expect(screen.getByRole("button", { name: /3\+ queued messages/ })).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(screen.getByRole("button", { name: /3\+ queued messages/ }));
  expect(screen.getByRole("button", { name: "Collapse queued messages" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Queued action" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Collapse queued messages" }));
  rerender(view(1));
  expect(screen.getByRole("button", { name: "Queued action" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Collapse queued messages" })).not.toBeInTheDocument();
});
it("defaults to collapsed in short panes but retains an explicit choice across resizes", async () => {
  size.short = false;
  const { rerender } = render(view(2));
  size.short = true;
  rerender(view(2));
  await userEvent.click(screen.getByRole("button", { name: /2 queued messages/ }));
  size.short = false; rerender(view(2));
  size.short = true; rerender(view(2));
  expect(screen.getByRole("button", { name: "Queued action" })).toBeVisible();
});
