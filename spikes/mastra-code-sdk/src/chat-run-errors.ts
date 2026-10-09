import { createHash } from 'node:crypto';

interface RunError {
  error: unknown;
  finishReason?: string;
  errorType?: string;
  retryable?: boolean;
  retryAttempt?: number;
  maxRetries?: number;
  retryDelay?: number;
}

// Retryable events announce native recovery, including the final allowed retry.
// The SDK emits a separate non-retryable event if recovery is exhausted.
export function isNativeRetry(event: RunError): boolean {
  return event.retryable === true;
}

function summary(value: string): string {
  return value.split(/[\r\n{\[]/, 1)[0]!
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s;,]+/gi, '[redacted authorization]')
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/g, '[redacted]')
    .replace(/\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
}

/** No raw error serialization: provider errors can carry credentials and requests. */
export function logChatRunError(chatId: string, event: RunError, write: (line: string) => void = console.error): void {
  const causes: object[] = [];
  const seen = new Set<unknown>();
  let error: unknown = event.error;
  for (let depth = 0; depth < 4 && error && !seen.has(error); depth++) {
    seen.add(error);
    const object = typeof error === 'object' ? error as Record<string, unknown> : {};
    const message = typeof object.message === 'string' ? object.message : typeof error === 'string' ? error : '';
    const status = object.statusCode ?? object.status;
    causes.push({
      name: typeof object.name === 'string' ? summary(object.name) : 'Error',
      message: summary(message),
      fingerprint: createHash('sha256').update(message).digest('hex').slice(0, 16),
      ...(typeof object.code === 'string' && { code: summary(object.code) }),
      ...(typeof status === 'number' && Number.isInteger(status) && { status }),
    });
    error = object.cause;
  }
  const retry = Object.fromEntries(['retryAttempt', 'maxRetries', 'retryDelay'].flatMap(key => {
    const value = event[key as keyof RunError];
    return typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : [];
  }));
  write(JSON.stringify({ event: 'chat.run_error', time: new Date().toISOString(), chatId, retrying: isNativeRetry(event), ...retry, ...(event.finishReason && { finishReason: summary(event.finishReason) }), ...(event.errorType && { errorType: summary(event.errorType) }), causes }));
}
