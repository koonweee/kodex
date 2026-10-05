import { payloadRecord } from "./presentationShared";

// View data normalized from the native agentMessage, not a gateway DTO.
export function asyncQuestions(payload: unknown): { title: string; options: string[] }[] {
  const record = payloadRecord(payload);
  const item = payloadRecord(record?.item) ?? record;
  if (item?.delivery !== "async" || !Array.isArray(item.questions) || !item.questions.length) return [];
  const questions: { title: string; options: string[] }[] = [];
  for (const value of item.questions) {
    const question = payloadRecord(value);
    if (typeof question?.title !== "string" || !question.title.trim()) return [];
    const options = question.options ?? [];
    if (!Array.isArray(options) || !options.every((option): option is string => typeof option === "string" && !!option.trim())) return [];
    questions.push({ title: question.title, options });
  }
  return questions;
}
