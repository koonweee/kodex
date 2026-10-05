import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "kodex-openapi-"));
try {
  const schema = execFileSync("cargo", ["run", "--quiet", "--locked", "-p", "kodex-gateway", "--example", "export_openapi"], { cwd: web, maxBuffer: 16 * 1024 * 1024 });
  const input = join(temporary, "openapi.json");
  writeFileSync(input, schema);
  execFileSync(process.execPath, [join(web, "node_modules/openapi-typescript/bin/cli.js"), input, "-o", join(web, "src/api/generated/schema.ts")], { cwd: web, stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
