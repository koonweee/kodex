import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ThreadGoal } from "../api/client";
import { GoalModal } from "./GoalModal";

const goal: ThreadGoal = {
  threadId: "thread-1", objective: "Finish the dashboard", status: "active",
  tokenBudget: 20000, tokensUsed: 4000, timeUsedSeconds: 90, createdAt: 1, updatedAt: 2,
};

function props(overrides: Partial<React.ComponentProps<typeof GoalModal>> = {}) {
  return { goal, pending: false, error: null, onClose: vi.fn(), onUpdate: vi.fn().mockResolvedValue(undefined),
    onClear: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function view(options: React.ComponentProps<typeof GoalModal>) {
  return <MantineProvider><GoalModal {...options} /></MantineProvider>;
}

describe("GoalModal", () => {
  it("saves only the edited objective while a native update changes status and usage", async () => {
    const options = props();
    const rendered = render(view(options));
    await userEvent.clear(screen.getByRole("textbox", { name: "Objective" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Objective" }), "Ship the dashboard");
    rendered.rerender(view({ ...options, goal: { ...goal, status: "paused", tokensUsed: 6000 } }));
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("Ship the dashboard");
    expect(screen.getByText("Paused")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(options.onUpdate).toHaveBeenCalledWith({ objective: "Ship the dashboard" }));
    expect(options.onClose).toHaveBeenCalled();
  });

  it("preserves a conflicting draft until the current objective is explicitly reviewed", async () => {
    const options = props();
    const rendered = render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "My edit" } });
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Changed in another tab" } }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(options.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Changed in another tab");
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("My edit");
    await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(options.onUpdate).toHaveBeenCalledWith({ objective: "My edit" }));
  });

  it("initializes the editor from the first successful read after a goal read failure", () => {
    const options = props({ goal: null, ready: false, error: "Goal unavailable" });
    const rendered = render(view(options));
    expect(screen.getByRole("button", { name: "Save goal" })).toBeDisabled();
    rendered.rerender(view({ ...options, goal, ready: true, error: null }));
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue(goal.objective);
    expect(screen.getByRole("spinbutton", { name: "Token budget" })).toHaveValue("20000");
  });

  it("includes a newly conflicting edited field in the open review", async () => {
    const options = props();
    const rendered = render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "My edit" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Token budget" }), { target: { value: "40000" } });
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Native edit" } }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Native edit");
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Native edit", tokenBudget: 30000 } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Token budget: 30,000");
    await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ objective: "My edit", tokenBudget: 40000 });
  });

  it("shows subsequent native edits in a pending conflict review", async () => {
    const options = props();
    const rendered = render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "My edit" } });
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Native edit A" } }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Native edit A");
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Native edit B" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Native edit B");
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("My edit");
    await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ objective: "My edit" });
  });

  it("keeps untouched fields at their latest native value when reviewing a conflicting edit", async () => {
    const options = props();
    const rendered = render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "My edit" } });
    rendered.rerender(view({ ...options, goal: { ...goal, objective: "Changed elsewhere", tokenBudget: 30000 } }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ objective: "My edit" });
  });

  it("keeps completed goals editable and clearable without resuming them", () => {
    render(view(props({ goal: { ...goal, status: "complete" } })));
    expect(screen.getByRole("textbox", { name: "Objective" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear goal" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume goal" })).not.toBeInTheDocument();
  });

  it("creates a goal with an optional token budget", async () => {
    const options = props({ goal: null });
    render(view(options));
    expect(screen.getByRole("button", { name: "Save goal" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "Finish the release" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Token budget" }), { target: { value: "10000" } });
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ objective: "Finish the release", tokenBudget: 10000 });
  });

  it.each(["paused", "blocked", "usageLimited", "budgetLimited"] as const)("resumes %s goals with a status-only edit", async (status) => {
    const options = props({ goal: { ...goal, status } });
    render(view(options));
    await userEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ status: "active" });
  });

  it("pauses and clears using independent native operations", async () => {
    const options = props();
    render(view(options));
    await userEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(options.onUpdate).toHaveBeenCalledWith({ status: "paused" });
    await userEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(options.onClear).toHaveBeenCalledOnce();
    expect(options.onClose).toHaveBeenCalled();
  });

  it("keeps failed edits open and preserves the draft", async () => {
    const options = props({ onUpdate: vi.fn().mockRejectedValue(new Error("Native goal unavailable")) });
    render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "Keep this draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Native goal unavailable");
    expect(options.onClose).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog", { name: "Goal" })).getByRole("textbox", { name: "Objective" })).toHaveValue("Keep this draft");
  });

  it("does not recreate a goal that was cleared while editing", async () => {
    const options = props();
    const rendered = render(view(options));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "My edit" } });
    rendered.rerender(view({ ...options, goal: null }));
    expect(screen.getByRole("alert")).toHaveTextContent("This goal was cleared");
    expect(screen.getByRole("button", { name: "Save goal" })).toBeDisabled();
    expect(options.onUpdate).not.toHaveBeenCalled();
  });
});
