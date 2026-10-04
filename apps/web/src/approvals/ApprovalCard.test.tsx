import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { Approval } from "../api/client";
import { ApprovalCard } from "./ApprovalCard";

it.each(["responding", "unavailable", "resolved"])("prevents a second response to a %s approval", (status) => {
  const approval: Approval = {
    id: "approval-1", requestId: "request-1", source: "native", status,
    method: "item/commandExecution/requestApproval", payload: { command: "cargo test" }, createdAt: "2026-10-04T00:00:00Z",
  };
  const onDecision = vi.fn();
  render(<MantineProvider><ApprovalCard approval={approval} onDecision={onDecision} /></MantineProvider>);
  const approve = screen.getByRole("button", { name: "Yes, proceed" });
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(onDecision).not.toHaveBeenCalled();
});
