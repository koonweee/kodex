import type { components } from "./generated/schema";

// Deliberately checked against the generated native contract when the API epoch changes.
export const API_VERSION = "4" satisfies components["schemas"]["ApiVersion"];
const HEADER = "x-kodex-api-version";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createApiCompatibility(
  upstream: FetchLike = (input, init) => globalThis.fetch(input, init),
) {
  let updateRequired = false;
  const listeners = new Set<() => void>();

  function required() {
    return updateRequired;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function observe(version: unknown) {
    if (version !== API_VERSION && !updateRequired) {
      updateRequired = true;
      listeners.forEach((listener) => listener());
    }
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    if (updateRequired && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      throw new Error("Update Kodex before making changes. Your draft has not been sent.");
    }
    request.headers.set(HEADER, API_VERSION);
    const response = await upstream(request);
    const version = response.headers.get(HEADER);
    if (version !== null) {
      observe(version);
      if (version !== API_VERSION) throw new Error("Update Kodex before continuing. Your draft has not been sent.");
    }
    return response;
  }

  function resetForTests() {
    updateRequired = false;
  }

  return { fetch, observe, required, resetForTests, subscribe };
}

export type ApiCompatibility = ReturnType<typeof createApiCompatibility>;

const defaultCompatibility = createApiCompatibility();

export const compatibilityRequired = defaultCompatibility.required;
export const subscribeCompatibility = defaultCompatibility.subscribe;
export const observeApiVersion = defaultCompatibility.observe;
export const compatibleFetch = defaultCompatibility.fetch;
export const resetCompatibilityForTests = defaultCompatibility.resetForTests;
