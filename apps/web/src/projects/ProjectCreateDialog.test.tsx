import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createProject, listDirectories } from "../api/client";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

vi.mock("../api/client", () => ({ createProject: vi.fn(), listDirectories: vi.fn() }));
afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  vi.mocked(listDirectories).mockImplementation(async (path) => ({
    path: path ?? "/home/test", homePath: "/home/test", parentPath: path && path !== "/home/test" ? "/home/test" : null,
    directories: path && path !== "/home/test" ? [] : [{ name: "Research", path: "/home/test/Research" }],
  }));
});
function setup() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider><ProjectCreateDialog onClose={vi.fn()} onCreated={vi.fn()} /></MantineProvider></QueryClientProvider>);
  return within(screen.getByRole("dialog", { name: "Add project" }));
}

it("browses from home, goes up, selects a single root and removes it", async () => {
  const dialog = setup();
  expect(dialog.queryByRole("textbox")).not.toBeInTheDocument();
  expect(dialog.getByRole("button", { name: "Add project" })).toBeDisabled();
  await dialog.findByRole("button", { name: "Research" });
  expect(dialog.getByRole("button", { name: "Go up" })).toBeDisabled();
  await userEvent.click(dialog.getByRole("button", { name: "Research" }));
  await waitFor(() => expect(dialog.getByRole("button", { name: "Go up" })).toBeEnabled());
  await userEvent.click(dialog.getByRole("button", { name: "Go up" }));
  // Returning home uses its canonical path, with no parent above it.
  await waitFor(() => expect(listDirectories).toHaveBeenCalledWith("/home/test", expect.any(AbortSignal)));
  await userEvent.click(dialog.getByRole("button", { name: "Use this directory" }));
  expect(dialog.queryByRole("button", { name: "Use this directory" })).not.toBeInTheDocument();
  expect(dialog.getByRole("button", { name: "Add project" })).toBeEnabled();
  await userEvent.click(dialog.getByRole("button", { name: "Remove root directory" }));
  expect(await dialog.findByRole("button", { name: "Use this directory" })).toBeVisible();
});

it("derives the name from the root and retains retry identity until selection changes", async () => {
  vi.mocked(createProject).mockRejectedValue(new Error("Reply lost"));
  const dialog = setup();
  await userEvent.click(await dialog.findByRole("button", { name: "Research" }));
  await waitFor(() => expect(dialog.getByRole("button", { name: "Go up" })).toBeEnabled());
  await userEvent.click(dialog.getByRole("button", { name: "Use this directory" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add project" }));
  await dialog.findByText("Reply lost");
  await userEvent.click(dialog.getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createProject).mock.calls[0][0]).toEqual(vi.mocked(createProject).mock.calls[1][0]);
  expect(vi.mocked(createProject).mock.calls[0][0]).toMatchObject({ name: "Research", roots: [{ path: "/home/test/Research" }] });
  await userEvent.click(dialog.getByRole("button", { name: "Remove root directory" }));
  await userEvent.click(await dialog.findByRole("button", { name: "Go up" }));
  await waitFor(() => expect(listDirectories).toHaveBeenCalledWith("/home/test", expect.any(AbortSignal)));
  await userEvent.click(dialog.getByRole("button", { name: "Use this directory" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(createProject).toHaveBeenCalledTimes(3));
  expect(vi.mocked(createProject).mock.calls[2][0].idempotencyKey).not.toBe(vi.mocked(createProject).mock.calls[0][0].idempotencyKey);
});

it("shows browse failures with retry and cannot select an unreadable directory", async () => {
  vi.mocked(listDirectories).mockRejectedValue(new Error("Directory unavailable"));
  const dialog = setup();
  expect(await dialog.findByText("Directory unavailable")).toBeVisible();
  expect(dialog.queryByRole("button", { name: "Use this directory" })).not.toBeInTheDocument();
  await userEvent.click(dialog.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(listDirectories).toHaveBeenCalledTimes(2));
});

it("can leave an unreadable child without retrying it", async () => {
  vi.mocked(listDirectories).mockImplementation(async (path) => {
    if (path === "/home/test/Private") throw new Error("Access denied");
    return { path: "/home/test", homePath: "/home/test", parentPath: null, directories: [{ name: "Private", path: "/home/test/Private" }] };
  });
  const dialog = setup();
  await userEvent.click(await dialog.findByRole("button", { name: "Private" }));
  await dialog.findByText("Access denied");
  await userEvent.click(dialog.getByRole("button", { name: "Back" }));
  expect(await dialog.findByRole("button", { name: "Private" })).toBeVisible();
  expect(dialog.getByRole("button", { name: "Go up" })).toBeDisabled();
});
