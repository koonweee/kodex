import { expect, it } from "vitest";
import type { ConfiguredMcpServer } from "../api/client";
import { initialMcpForm, mcpLeafEdits } from "./mcpForm";

it.each(["replace", "clear"] as const)("treats a stored __proto__ secret as a literal native key for %s", (mode) => {
  const server: ConfiguredMcpServer = {
    name: "native", enabled: true, hasStoredSecrets: true,
    transport: { type: "streamableHttp", url: "https://example.test/mcp", httpHeaders: { ["__proto__"]: { configured: true, masked: true } } },
  };
  const initial = initialMcpForm(server);
  const form = { ...initial, headerSecrets: { ...initial.headerSecrets, ["__proto__"]: { mode, value: "replacement" } } };
  expect(mcpLeafEdits(form, initial)).toEqual([{ keyPath: ["http_headers", "__proto__"], value: mode === "replace" ? "replacement" : null }]);
});

it("removes a literal header environment name without inheriting a JavaScript object property", () => {
  const server: ConfiguredMcpServer = { name: "native", enabled: true, hasStoredSecrets: false,
    transport: { type: "streamableHttp", url: "https://example.test/mcp", envHttpHeaders: { constructor: "TOKEN_ENV" } },
  };
  const initial = initialMcpForm(server);
  expect(mcpLeafEdits({ ...initial, envHttpHeaders: "" }, initial)).toEqual([{ keyPath: ["env_http_headers", "constructor"], value: null }]);
});
