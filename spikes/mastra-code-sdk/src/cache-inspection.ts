import { createHash } from 'node:crypto';

export interface ComponentFingerprint { hash: string; length: number }
export interface InputItemFingerprint extends ComponentFingerprint { role: string | null; type: string | null }
export interface SafeRequestSummary {
  root: ComponentFingerprint;
  model: string | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  store: boolean | null;
  cache: { keyPresent: boolean; mode: string | null; ttl: string | null; retention: string | null };
  instructions: ComponentFingerprint | null;
  tools: (ComponentFingerprint & { count: number | null }) | null;
  input: ComponentFingerprint | null;
  inputItems: InputItemFingerprint[];
}
export interface SafePrefixComparison {
  instructionsEqual: boolean;
  toolsEqual: boolean;
  commonLeadingInputItems: number;
  instructionCommonPrefixLength: number;
  toolCommonPrefixLength: number;
  inputCommonPrefixLength: number;
}

// Only known diagnostic values can be emitted. Unknown scalars stay null rather
// than being copied from untrusted request fields (including IDs or secrets).
const models = ['gpt-6.1-sol', 'openai/gpt-6.1-sol'];
const roles = ['system', 'developer', 'user', 'assistant', 'tool'];
const itemTypes = ['message', 'function_call', 'function_call_output', 'reasoning', 'item_reference', 'compaction', 'local_shell_call', 'local_shell_call_output', 'web_search_call', 'computer_call', 'computer_call_output', 'file_search_call', 'code_interpreter_call', 'image_generation_call', 'custom_tool_call', 'custom_tool_call_output', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response'];
function allow(value: unknown, values: readonly string[]): string | null {
  return typeof value === 'string' && values.includes(value) ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function serialize(value: unknown, verbatimString = false): string {
  if (verbatimString && typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; }
  catch { return ''; } // Invalid/circular input emits no value or error payload.
}
function fingerprint(text: string): ComponentFingerprint {
  return { hash: createHash('sha256').update(text, 'utf8').digest('hex'), length: Buffer.byteLength(text, 'utf8') };
}
function component(value: unknown): ComponentFingerprint | null {
  return value === undefined || value === null ? null : fingerprint(serialize(value, true));
}
function inputOf(body: Record<string, unknown>): unknown {
  return Object.hasOwn(body, 'input') ? body.input : body.messages;
}

/** Hashes and UTF-8 byte lengths only; no request text, IDs, paths or keys escape.
 * JSON property order and tool/item array order are deliberately preserved.
 * This describes submitted JSON stability, not the provider's tokenized prefix.
 */
export function summarizeRequest(body: unknown): SafeRequestSummary {
  const request = record(body);
  const reasoning = record(request.reasoning);
  const cache = record(request.prompt_cache_options);
  const input = inputOf(request);
  const tools = component(request.tools);
  return {
    root: fingerprint(serialize(body)),
    model: allow(request.model, models),
    reasoningEffort: allow(reasoning.effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
    reasoningSummary: allow(reasoning.summary, ['auto', 'concise', 'detailed']),
    store: typeof request.store === 'boolean' ? request.store : null,
    cache: {
      keyPresent: typeof request.prompt_cache_key === 'string' && request.prompt_cache_key.length > 0,
      mode: allow(cache.mode, ['implicit', 'explicit']),
      ttl: allow(cache.ttl, ['5m', '1h', '24h']),
      retention: allow(request.prompt_cache_retention, ['in_memory', '5m', '1h', '24h']),
    },
    instructions: component(request.instructions),
    tools: tools ? { ...tools, count: Array.isArray(request.tools) ? request.tools.length : null } : null,
    input: component(input),
    inputItems: Array.isArray(input) ? input.map(item => ({
      ...fingerprint(serialize(item)),
      role: allow(record(item).role, roles),
      type: allow(record(item).type, itemTypes),
    })) : [],
  };
}
function prefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length++;
  return length;
}

/** Prefix lengths are UTF-16 code units of compact JSON (raw strings verbatim).
 * No substring is returned. Exact equality covers IDs as well as message text;
 * different IDs need not imply different provider tokenization or cache behavior.
 */
export function compareRequestPrefixes(before: unknown, after: unknown): SafePrefixComparison {
  const left = record(before);
  const right = record(after);
  const leftInput = inputOf(left);
  const rightInput = inputOf(right);
  const leftItems = Array.isArray(leftInput) ? leftInput : [];
  const rightItems = Array.isArray(rightInput) ? rightInput : [];
  let commonLeadingInputItems = 0;
  while (commonLeadingInputItems < Math.min(leftItems.length, rightItems.length) && serialize(leftItems[commonLeadingInputItems]) === serialize(rightItems[commonLeadingInputItems])) commonLeadingInputItems++;
  const instructionsBefore = serialize(left.instructions, true);
  const instructionsAfter = serialize(right.instructions, true);
  const toolsBefore = serialize(left.tools);
  const toolsAfter = serialize(right.tools);
  return {
    instructionsEqual: instructionsBefore === instructionsAfter,
    toolsEqual: toolsBefore === toolsAfter,
    commonLeadingInputItems,
    instructionCommonPrefixLength: prefixLength(instructionsBefore, instructionsAfter),
    toolCommonPrefixLength: prefixLength(toolsBefore, toolsAfter),
    inputCommonPrefixLength: prefixLength(serialize(leftInput, true), serialize(rightInput, true)),
  };
}
