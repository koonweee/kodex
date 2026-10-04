import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { createProject } from "../api/client";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

vi.mock("../api/client", () => ({ createProject: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("uses a new native create key when the user changes the intent after an uncertain failure", async () => {
  vi.mocked(createProject).mockRejectedValue(new Error("Reply lost"));
  render(<QueryClientProvider client={new QueryClient()}><MantineProvider><ProjectCreateDialog onClose={vi.fn()} onCreated={vi.fn()} /></MantineProvider></QueryClientProvider>);
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Project name" }), "First intent");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  await within(dialog).findByText("Reply lost");
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Root directories" }), "/first\n/second");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
  const [first, changed] = vi.mocked(createProject).mock.calls.map(([request]) => request);
  expect(changed).toMatchObject({ name: "First intent", roots: [{ path: "/first" }, { path: "/second" }] });
  expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
});
