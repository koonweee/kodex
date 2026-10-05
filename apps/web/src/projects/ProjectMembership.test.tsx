import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, baseRoutes, FakeEventSource, mockGateway } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeEventSource.instances = []; });

it("offers chat actions without project reassignment", async () => {
  mockGateway(baseRoutes());
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Thread actions" }));
  expect(await screen.findByRole("menuitem", { name: "Rename thread" })).toBeEnabled();
  expect(screen.queryByText("Move chat to project")).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "No project" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Kodex" })).not.toBeInTheDocument();
});
