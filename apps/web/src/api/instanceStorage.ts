export type InstanceStorage = Pick<Storage, "getItem" | "setItem">;

export function createInstanceStorage(
  instanceId: string,
  storage: InstanceStorage | null = browserStorage(),
): InstanceStorage | null {
  if (!storage || !instanceId.trim()) {
    return null;
  }
  const prefix = `kodex.instance.${encodeURIComponent(instanceId)}:`;
  return {
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
  };
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
