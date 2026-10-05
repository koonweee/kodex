import type { components } from "./generated/schema";

// Deliberately checked against the generated native contract when the API epoch changes.
const API_VERSION = "1" satisfies components["schemas"]["ApiVersion"];
const HEADER = "x-kodex-api-version";
let required = false;
const listeners = new Set<() => void>();
export const compatibilityRequired = () => required;
export function subscribeCompatibility(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function observeApiVersion(version: unknown) {
  if (version !== API_VERSION && !required) {
    required = true;
    listeners.forEach((listener) => listener());
  }
}
export async function compatibleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (required && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    throw new Error("Update Kodex before making changes. Your draft has not been sent.");
  }
  request.headers.set(HEADER, API_VERSION);
  const response = await globalThis.fetch(request);
  const version = response.headers.get(HEADER);
  if (version !== null) {
    observeApiVersion(version);
    if (version !== API_VERSION) throw new Error("Update Kodex before continuing. Your draft has not been sent.");
  }
  return response;
}
export function resetCompatibilityForTests() { required = false; }
