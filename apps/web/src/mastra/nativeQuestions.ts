import { asyncQuestions } from '../timeline/asyncQuestions';
import { payloadRecord } from '../timeline/presentationShared';
import type { TimelineItem } from '../timeline/state';

type QuestionFields = Pick<TimelineItem, 'id' | 'kind' | 'serverItemId' | 'asyncQuestions'>;

/** A successful native tool call owns the question payload. The card is a
 * projection of that call, never a second assistant message or prompt store.
 */
export function nativeQuestionFields(name: string, args: unknown, result: unknown, failed: boolean, completed: boolean, messageId: string | undefined, toolCallId: string): QuestionFields | null {
  if (name !== 'request_user_input_async' || failed || !completed || !messageId || payloadRecord(result)?.accepted !== true) return null;
  const input = payloadRecord(args);
  if (!Array.isArray(input?.questions) || Object.keys(input).some(key => key !== 'questions')) return null;
  // The main card parser accepts empty display options. The native tool requires
  // at least one option when an array is supplied; null means free text.
  if (input.questions.some(question => {
    const record = payloadRecord(question), options = record?.options;
    return record && Object.keys(record).some(key => key !== 'title' && key !== 'options') || Array.isArray(options) && options.length === 0;
  })) return null;
  const questions = asyncQuestions({ delivery: 'async', questions: input.questions });
  if (!questions.length) return null;
  const id = JSON.stringify([messageId, toolCallId]);
  return { id, serverItemId: id, kind: 'assistant_message', asyncQuestions: questions };
}

/** Native message identity remains independent of the client's fresh attempt.
 * Only explicit correlation metadata can turn an ordinary input into an answer.
 */
export function nativeQuestionReplyClientId(metadata: unknown): string | undefined {
  const signal = payloadRecord(payloadRecord(metadata)?.signal);
  const clientId = payloadRecord(signal?.metadata)?.clientId;
  return typeof clientId === 'string' ? clientId : undefined;
}
