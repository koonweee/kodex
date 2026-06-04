import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GatewayTerminalLauncher } from "./GatewayTerminalLauncher";

describe("GatewayTerminalLauncher", () => {
  it("exposes an icon button trigger", async () => {
    const onOpen = vi.fn();
    render(
      <MantineProvider>
        <GatewayTerminalLauncher onOpen={onOpen} />
      </MantineProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
