import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncQuestionReplyProvider } from "../composer/AsyncQuestionReplyProvider";
import { submitThreadInput } from "../api/client";
import { TimelineItemRenderer } from "./renderers";
import type { TimelineItem } from "./state";
vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), submitThreadInput: vi.fn() }));
const item: TimelineItem = { id: "question", serverItemId: "native-question", kind: "assistant_message", status: "completed", turnId: "turn", displayOrder: 1, text: "Fallback bullets", debugEvents: [], payload: {}, asyncQuestions: [{ title: "Finish **login**?", options: ["I’ll log in now", "Continue without live validation"] }] };
function view(enabled = true, visible = true) {
  return <MantineProvider><AsyncQuestionReplyProvider threadId="pal" enabled={enabled}>{visible ? <TimelineItemRenderer item={item} threadId="pal" /> : null}</AsyncQuestionReplyProvider></MantineProvider>;
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
  it("retains drafts across virtual row unmounts and errors, prevents concurrent sends and clears after success", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(submitThreadInput).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const rendered = render(view());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "logged in" } });
    rendered.rerender(view(true, false));
    rendered.rerender(view());
    expect(screen.getByRole("textbox")).toHaveValue("logged in");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
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
  it("does not expose submission controls in an observer or enable unavailable chats", () => {
    const rendered = render(<MantineProvider><TimelineItemRenderer item={item} /></MantineProvider>);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I’ll log in now" })).not.toBeInTheDocument();
    rendered.rerender(view(false));
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "I’ll log in now" })).toBeDisabled();
  });
});
