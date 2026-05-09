import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

import { queryClient } from "../api/queryClient";

const localStorageState = new Map<string, string>();

if (typeof window.localStorage?.getItem !== "function") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => localStorageState.clear(),
      getItem: (key: string) => localStorageState.get(key) ?? null,
      key: (index: number) => Array.from(localStorageState.keys())[index] ?? null,
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      setItem: (key: string, value: string) => {
        localStorageState.set(key, String(value));
      },
      get length() {
        return localStorageState.size;
      },
    },
  });
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:kodex-test";
}

if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => undefined;
}

async function resetQueryClient() {
  await queryClient.cancelQueries();
  queryClient.clear();
}

beforeEach(async () => {
  await resetQueryClient();
  window.history.replaceState(null, "", "/threads/thread-1");
});

afterEach(async () => {
  await resetQueryClient();
});
