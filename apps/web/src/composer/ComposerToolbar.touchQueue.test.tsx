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

describe("touch Send hold to queue", () => {
  it("queues once after a sustained touch and suppresses the release click", () => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown");
    act(() => vi.advanceTimersByTime(449));
    expect(submit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledExactlyOnceWith("queue");
    pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps a short touch and a mouse press as ordinary Send", () => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown"); act(() => vi.advanceTimersByTime(100));
    pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).toHaveBeenLastCalledWith("send");
    pointer(send(), "pointerdown", { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    pointer(send(), "pointerup", { pointerType: "mouse" }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith("send");
  });
  it.each(["pointermove", "pointerleave", "pointercancel"])("cancels a touch gesture on %s without submitting", (type) => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown"); pointer(send(), type, { clientX: 30 });
    act(() => vi.advanceTimersByTime(1000)); pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).not.toHaveBeenCalled();
    pointer(send(), "pointerdown"); pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
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
  it("preserves a keyboard submission after canceling a touch gesture", () => {
    const submit = vi.fn(); render(view(submit));
    pointer(send(), "pointerdown"); pointer(send(), "pointercancel");
    fireEvent.keyDown(send(), { key: "Enter" }); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
  it("does not queue a draft thread on hold", () => {
    const submit = vi.fn(); render(view(submit, { selectedThreadPresent: false }));
    pointer(send(), "pointerdown"); act(() => vi.advanceTimersByTime(1000)); pointer(send(), "pointerup"); fireEvent.click(send());
    expect(submit).toHaveBeenCalledExactlyOnceWith("send");
  });
});
