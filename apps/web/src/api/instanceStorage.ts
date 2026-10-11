export type InstanceStorage = Pick<Storage, "getItem" | "setItem">;

export function createInstanceStorage(
  instanceId: string,
  storage: InstanceStorage | null = browserStorage(),
): InstanceStorage | null {
  if (!storage || !instanceId.trim()) {
    return null;
  }
  return createPrefixedStorage(`kodex.instance.${encodeURIComponent(instanceId)}:`, storage);
}

export function createExecutorStorage(
  executorId: string,
  instanceId: string,
  storage: InstanceStorage | null = browserStorage(),
): InstanceStorage | null {
  if (!storage || !executorId.trim() || !instanceId.trim()) {
    return null;
  }
  return createPrefixedStorage(
    `kodex.executor.${encodeURIComponent(executorId)}.${encodeURIComponent(instanceId)}:`,
    storage,
  );
}

function createPrefixedStorage(prefix: string, storage: InstanceStorage): InstanceStorage {
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
