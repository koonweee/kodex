import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../timeline/state";
import { asyncQuestionKey, canonicalQuestionAnswers, questionReplyClientId } from "./asyncQuestionReplies";

const question: TimelineItem = { id: "row-question", serverItemId: "native-question", kind: "assistant_message", status: "completed", turnId: "turn", displayOrder: 1, text: "Question?", payload: {}, debugEvents: [] };
const key = asyncQuestionKey(question, 0);
function reply(clientId: string, text = "done"): TimelineItem {
  return { ...question, id: "native-reply", kind: "user_message", text, clientId, source: "app_server" };
}
describe("native question reply correlation", () => {
  it("assigns fresh attempt IDs and restores the exact answer from native history", () => {
    const first = questionReplyClientId(key);
    expect(questionReplyClientId(key)).not.toBe(first);
    expect(canonicalQuestionAnswers([question, reply(first, "done\nSigned in")])).toEqual({ [key]: "done\nSigned in" });
  });
  it("does not consume a question from an ordinary, optimistic or malformed user input", () => {
    const inputs = [reply("ordinary-id"), { ...reply(questionReplyClientId(key)), source: "optimistic" as const },
      reply("kodex-question-reply:v1:invalid"), reply('kodex-question-reply:v1:["invalid-key","nonce"]')];
    expect(canonicalQuestionAnswers(inputs)).toEqual({});
  });
  it("keeps questions and indices distinct and displays the first canonical answer when attempts race", () => {
    const other = asyncQuestionKey({ ...question, serverItemId: "another-question" }, 0);
    const second = asyncQuestionKey(question, 1);
    expect(canonicalQuestionAnswers([reply(questionReplyClientId(key), "first"), reply(questionReplyClientId(key), "racing"),
      reply(questionReplyClientId(other), "other"), reply(questionReplyClientId(second), "second")])).toEqual({ [key]: "first", [other]: "other", [second]: "second" });
  });
  it("removes answered status when canonical revert no longer contains the reply", () => {
    expect(canonicalQuestionAnswers([reply(questionReplyClientId(key))])).toHaveProperty(key, "done");
    expect(canonicalQuestionAnswers([question])).toEqual({});
  });
});
