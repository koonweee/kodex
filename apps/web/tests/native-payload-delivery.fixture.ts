// Deterministic fixture projection. Real gateway filtering is verified by backend tests.
export function projectPayloadDelivery<T>(source: T, url: URL): T {
  const debug = url.searchParams.get("includeDebugEvents") === "true";
  const outputs = url.searchParams.get("includeCommandOutputs") === "true";
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.itemType && record.payload) {
      const payload = record.payload as { item: Record<string, unknown> };
      let item = { ...payload.item };
      if (record.itemType === "fixtureDebug" && !debug) item = {};
      if (record.itemType === "commandExecution" && !outputs) {
        const { aggregatedOutput: _aggregatedOutput, output: _output, stdout: _stdout, stderr: _stderr, ...display } = item;
        item = display;
      }
      return { ...record, payload: { ...payload, item } };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child)]));
  }
  return visit(source) as T;
}
