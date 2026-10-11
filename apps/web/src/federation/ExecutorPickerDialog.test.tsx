import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { ExecutorPickerDialog } from "./ExecutorPickerDialog";

it("suggests the last available executor and confirms an explicit owner", async () => {
  const onConfirm = vi.fn();
  render(
    <MantineProvider>
      <ExecutorPickerDialog
        choices={[{ id: "mac", name: "Desk Mac" }, { id: "linux", name: "Build Linux" }]}
        kind="chat"
        onClose={() => undefined}
        onConfirm={onConfirm}
        opened
        preferredExecutorId="linux"
      />
    </MantineProvider>,
  );

  expect(screen.getByRole("textbox", { name: "Executor" })).toHaveValue("Build Linux");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onConfirm).toHaveBeenCalledWith("linux");
});
