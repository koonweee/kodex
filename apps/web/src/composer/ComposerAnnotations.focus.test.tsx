import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ComposerAnnotations } from "./ComposerAnnotations";
import { useComposerDraftState, type ComposerDraftStore } from "./useComposerDraftState";

function AnnotationComposer({ collapsed = false, draftKey = "one", store }: {
  collapsed?: boolean;
  draftKey?: string;
  store?: ComposerDraftStore;
}) {
  const draftState = useComposerDraftState(0, draftKey, store);
  return <MantineProvider env="test">
    <button onClick={() => draftState.addAnnotation("Selected answer")}>Add annotation</button>
    <input aria-label="Other input" />
    <ComposerAnnotations draftState={draftState} disabled={false} collapseByDefault={collapsed} />
  </MantineProvider>;
}

describe("annotation input focus", () => {
  it.each([false, true])("focuses each newly added comment and opens a collapsed tray (mobile %s)", async (collapsed) => {
    render(<AnnotationComposer collapsed={collapsed} />);
    await userEvent.click(screen.getByRole("button", { name: "Add annotation" }));
    const first = screen.getByRole("textbox", { name: "Annotation 1 comment" });
    expect(first).toHaveFocus();
    await userEvent.keyboard("First comment");
    expect(first).toHaveValue("First comment");
    await userEvent.click(screen.getByRole("button", { name: "1 annotation" }));
    await userEvent.click(screen.getByRole("button", { name: "Add annotation" }));
    expect(screen.getByRole("textbox", { name: "Annotation 2 comment" })).toHaveFocus();
    expect(first).toHaveValue("First comment");
    await userEvent.click(screen.getByRole("textbox", { name: "Other input" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove annotation 2" }));
    expect(first).not.toHaveFocus();
  });

  it("does not take focus when a stored annotation draft is restored or switched", async () => {
    const store: ComposerDraftStore = new Map(["one", "two"].map((key) => [key, {
      composerText: "", skillBindings: [], annotations: [{ id: key, text: "Saved excerpt", comment: "Saved comment" }],
    }]));
    const view = render(<AnnotationComposer store={store} />);
    const other = screen.getByRole("textbox", { name: "Other input" });
    await userEvent.click(other);
    view.rerender(<AnnotationComposer store={store} draftKey="two" />);
    expect(other).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Annotation 1 comment" })).toHaveValue("Saved comment");
  });
});
