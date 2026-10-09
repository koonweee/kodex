import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "./ComposerToolbar";

type Props = ComponentProps<typeof ComposerToolbar>;
function view(onSubmit: (intent: string) => void, props: Partial<Props> = {}) {
  return <MantineProvider env="test"><form id="composer" onSubmit={(event) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;
    onSubmit(submitter?.dataset.submitIntent ?? "send");
  }}>
    <button type="submit" hidden data-submit-intent="queue" />
    <ComposerToolbar formId="composer" attachmentInputRef={{ current: null }} canSubmitComposer disabled={false}
      models={[]} onSettingsChange={vi.fn()} onStopTurn={vi.fn()} selectedThreadPresent settings={null}
      shouldShowStopAction={false} isSubmitting={false} {...props} />
  </form></MantineProvider>;
}
function pointer(target: HTMLElement, type: string, init: Record<string, unknown> = {}) {
  const event = new Event(type === "pointerleave" ? "pointerout" : type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: "touch", pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10, ...init });
  fireEvent(target, event);
}
const send = () => screen.getByRole("button", { name: "Send message" });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Send hold to queue", () => {
  it("removes its portalled attachment menu in the disabling render", () => {
    const submit = vi.fn();
    const rendered = render(view(submit));
    fireEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
    expect(screen.getByRole("menu", { hidden: true })).toBeInTheDocument();

    rendered.rerender(view(submit, { disabled: true }));
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeInTheDocument();
  });

  it.each(["touch", "mouse", "pen"])("queues once after a sustained %s press and suppresses the release click", (pointerType) => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown", { pointerType });
    act(() => vi.advanceTimersByTime(449));
    expect(submit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledExactlyOnceWith("queue");
    pointer(send(), "pointerup", { pointerType }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps short touch and mouse presses as ordinary Send", () => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown"); act(() => vi.advanceTimersByTime(100));
    pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).toHaveBeenLastCalledWith("send");
    pointer(send(), "pointerdown", { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(100));
    pointer(send(), "pointerup", { pointerType: "mouse" }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith("send");
  });
  it.each(["touch", "mouse"].flatMap(pointerType => ["pointermove", "pointerleave", "pointercancel"].map(type => ({ pointerType, type }))))("cancels $pointerType on $type without submitting", ({ pointerType, type }) => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown", { pointerType }); pointer(send(), type, { pointerType, clientX: 30 });
    act(() => vi.advanceTimersByTime(1000)); pointer(send(), "pointerup", { pointerType }); fireEvent.click(send());
    expect(submit).not.toHaveBeenCalled();
    pointer(send(), "pointerdown", { pointerType }); pointer(send(), "pointerup", { pointerType }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
  it.each([
    { pointerType: "mouse", button: 2 },
    { pointerType: "touch", isPrimary: false },
  ])("ignores secondary presses: $pointerType", (init) => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown", init);
    act(() => vi.advanceTimersByTime(1000));
    pointer(send(), "pointerup", init);
    expect(submit).not.toHaveBeenCalled();
  });
  it("cancels pending holds when disabled or unmounted", () => {
    const submit = vi.fn(); const rendered = render(view(submit));
    pointer(send(), "pointerdown"); rendered.rerender(view(submit, { canSubmitComposer: false }));
    act(() => vi.advanceTimersByTime(1000)); expect(submit).not.toHaveBeenCalled();
    rendered.rerender(view(submit)); pointer(send(), "pointerdown"); rendered.unmount();
    act(() => vi.advanceTimersByTime(1000)); expect(submit).not.toHaveBeenCalled();
  });
  it("labels a visible queue while ordinary submission still delegates routing", () => {
    const submit = vi.fn(); render(view(submit, { queueOnSubmit: true }));
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
  it.each([
    { queueOnSubmit: true, label: "Send now" },
    { queueOnSubmit: false, label: "Add to queue" },
  ])("matches the previewed $label action when Command is held", ({ queueOnSubmit, label }) => {
    const submit = vi.fn(); render(view(submit, { alternateSubmitPreview: true, queueOnSubmit }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(submit).toHaveBeenCalledExactlyOnceWith("alternate");
  });
  it("preserves a keyboard submission after canceling a touch gesture", () => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown"); pointer(send(), "pointercancel");
    fireEvent.keyDown(send(), { key: "Enter" }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
  it.each(["touch", "mouse"])("does not queue a draft thread on %s hold", (pointerType) => {
    const submit = vi.fn(); render(view(submit, { selectedThreadPresent: false }));
    pointer(send(), "pointerdown", { pointerType }); act(() => vi.advanceTimersByTime(1000)); pointer(send(), "pointerup", { pointerType }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
});
