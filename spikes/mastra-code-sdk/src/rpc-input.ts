/** Actual Standard Schema validation, including nested sparse settings patches. */
export function inputSchema<T>(valid: (value: unknown) => boolean) {
  const standard: {
    version: 1; vendor: string; types?: { input: T; output: T };
    validate(value: unknown): { value: T } | { issues: Array<{ message: string }> };
  } = {
    version: 1, vendor: 'kodex-chat',
    validate(value) { return valid(value) ? { value: value as T } : { issues: [{ message: 'Invalid input fields.' }] }; },
  };
  return { '~standard': standard };
}
