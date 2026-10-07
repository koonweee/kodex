import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncQuestionAnswersProvider, AsyncQuestionReplyProvider } from "../composer/AsyncQuestionReplyProvider";
import { submitThreadInput } from "../api/client";
import { TimelineItemRenderer } from "./renderers";
import type { TimelineItem } from "./state";
import { asyncQuestionKey, questionReplyClientId } from "../composer/asyncQuestionReplies";
vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), submitThreadInput: vi.fn() }));
const item: TimelineItem = { id: "question", serverItemId: "native-question", kind: "assistant_message", status: "completed", turnId: "turn", displayOrder: 1, text: "Fallback bullets", debugEvents: [], payload: {}, asyncQuestions: [{ title: "Finish **login**?", options: ["I’ll log in now", "Continue without live validation"] }] };
function view(enabled = true, visible = true, items: TimelineItem[] = []) {
  return <MantineProvider><AsyncQuestionReplyProvider threadId="pal" enabled={enabled} items={items}>{visible ? <TimelineItemRenderer item={item} threadId="pal" /> : null}</AsyncQuestionReplyProvider></MantineProvider>;
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("async question card", () => {
  it("renders a Markdown question once, always-open free text and exact choice replies", async () => {
    vi.mocked(submitThreadInput).mockResolvedValue({ payload: {} });
    render(view());
    expect(await screen.findByText("login")).toBeVisible();
    expect(screen.queryByText("Fallback bullets")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply to question 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I’ll log in now" }));
    await waitFor(() => expect(submitThreadInput).toHaveBeenCalledWith("pal", [{ type: "text", text: "I’ll log in now" }], [], expect.any(String)));
  });
  it("submits with Enter, keeps Shift+Enter as a newline and ignores IME confirmation", async () => {
    vi.mocked(submitThreadInput).mockResolvedValue({ payload: {} });
    const user = userEvent.setup();
    render(view());
    const reply = screen.getByRole("textbox");
    fireEvent.change(reply, { target: { value: "First line" } });
    expect(fireEvent.keyDown(reply, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(reply, { key: "Enter", isComposing: true })).toBe(true);
    expect(submitThreadInput).not.toHaveBeenCalled();
    await user.click(reply);
    await user.keyboard("{Shift>}{Enter}{/Shift}Second line");
    expect(reply).toHaveValue("First line\nSecond line");
    expect(fireEvent.keyDown(reply, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(submitThreadInput).toHaveBeenCalledWith("pal", [{ type: "text", text: "First line\nSecond line" }], [], expect.any(String)));
    await waitFor(() => expect(reply).toHaveValue(""));
    fireEvent.keyDown(reply, { key: "Enter" });
    expect(submitThreadInput).toHaveBeenCalledTimes(1);
  });
  it("retains drafts across virtual row unmounts and errors, prevents concurrent sends and clears after success", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(submitThreadInput).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const rendered = render(view());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "logged in" } });
    rendered.rerender(view(true, false));
    rendered.rerender(view());
    expect(screen.getByRole("textbox")).toHaveValue("logged in");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "I’ll log in now" }));
    expect(submitThreadInput).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Connection lost")));
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("textbox")).toHaveValue("logged in");
    vi.mocked(submitThreadInput).mockResolvedValue({ payload: {} });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(submitThreadInput).toHaveBeenLastCalledWith("pal", [{ type: "text", text: "logged in" }], [], expect.any(String));
    expect(vi.mocked(submitThreadInput).mock.calls[0][3]).not.toBe(vi.mocked(submitThreadInput).mock.calls[1][3]);
  });
  it("collapses a canonical answer, restores it after remount and removes every submission control", async () => {
    const answer: TimelineItem = { ...item, id: "reply", kind: "user_message", text: "done\nSigned in", asyncQuestions: undefined,
      clientId: questionReplyClientId(asyncQuestionKey(item, 0)) };
    const rendered = render(view());
    expect(screen.getByRole("textbox")).toBeVisible();
    rendered.rerender(view(true, true, [item, answer]));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();
    expect(rendered.container.querySelector("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Input requested"));
    expect(await screen.findByText("login")).toBeVisible();
    expect(screen.getByRole("blockquote")).toHaveTextContent("done Signed in");
    expect(screen.queryByRole("button", { name: "I’ll log in now" })).not.toBeInTheDocument();
    rendered.unmount();
    render(view(true, true, [item, answer]));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(submitThreadInput).not.toHaveBeenCalled();
  });
  it("shows persisted answers in read-only observers without exposing input controls", async () => {
    const answer: TimelineItem = { ...item, id: "reply", kind: "user_message", text: "done", asyncQuestions: undefined,
      clientId: questionReplyClientId(asyncQuestionKey(item, 0)) };
    render(<MantineProvider><AsyncQuestionAnswersProvider items={[item, answer]}><TimelineItemRenderer item={item} /></AsyncQuestionAnswersProvider></MantineProvider>);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Input requested"));
    expect(screen.getByRole("blockquote")).toHaveTextContent("done");
  });
  it("does not expose submission controls in an observer or enable unavailable chats", () => {
    const rendered = render(<MantineProvider><TimelineItemRenderer item={item} /></MantineProvider>);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I’ll log in now" })).not.toBeInTheDocument();
    rendered.rerender(view(false));
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "I’ll log in now" })).toBeDisabled();
  });
});
