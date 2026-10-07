export type WireResult = {
  status: number;
  completed: boolean;
  correct: boolean;
  input: number | null;
  cached: number | null;
  output: number | null;
  cacheWrite: number | null;
  elapsedMs: number;
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Consume Responses SSE without returning or logging text, IDs or provider errors.
 * Usage is taken only from terminal provider fields; missing values stay unknown.
 */
export async function readCacheResult(response: Response, started: number, expectedAnswer = 'CACHE_PROBE_OK'): Promise<WireResult> {
  const result: WireResult = { status: response.status, completed: false, correct: false, input: null, cached: null, output: null, cacheWrite: null, elapsedMs: 0 };
  const finish = () => { result.elapsedMs = Math.max(0, performance.now() - started); return result; };
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return finish();
  }
  if (!response.body) return finish();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let failed = false;
  let eventName = '';
  let data: string[] = [];
  const dispatch = () => {
    const payload = data.join('\n');
    const name = eventName;
    data = [];
    eventName = '';
    if (!payload || payload.trim() === '[DONE]') return;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(payload)); } catch { return; }
    const type = typeof event.type === 'string' ? event.type : name;
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') answer += event.delta;
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') failed = true;
    if (type === 'response.completed') {
      const terminal = record(event.response);
      const usage = record(terminal.usage);
      const details = record(usage.input_tokens_details);
      result.completed = terminal.status === 'completed';
      result.input = numeric(usage.input_tokens);
      result.output = numeric(usage.output_tokens);
      result.cached = numeric(details.cached_tokens);
      // These are observed field aliases, not an assumption that cache-write
      // usage is supplied by this provider or inferable from total/cache reads.
      result.cacheWrite = numeric(details.cache_write_tokens) ?? numeric(details.cache_creation_tokens);
    }
  };
  const line = (raw: string) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!text) { dispatch(); return; }
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    if (text.startsWith('event:')) eventName = text.slice(6).trim();
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer) line(buffer);
    dispatch();
  } catch {
    failed = true;
  } finally {
    reader.releaseLock();
  }
  result.completed &&= !failed;
  result.correct = result.completed && answer.trim() === expectedAnswer;
  return finish();
}
