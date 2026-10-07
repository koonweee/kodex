import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { activateProfile, resolveProfile } from "./profile.js";
import { authStatus, loginChatGpt, safeAuthError } from "./auth.js";

interface Arguments {
  command: "login" | "status";
  root?: string;
  mode: "device" | "browser";
}

function parseArguments(args: string[]): Arguments {
  const parsed: Arguments = { command: "status", mode: "device" };
  let commandSeen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "login" || arg === "status") && !commandSeen) {
      parsed.command = arg;
      commandSeen = true;
    } else if (arg === "--profile" && args[index + 1]) {
      parsed.root = args[++index];
    } else if (arg === "--mode" && (args[index + 1] === "device" || args[index + 1] === "browser")) {
      parsed.mode = args[++index] as Arguments["mode"];
    } else {
      throw new Error("Usage: npm run login -- [status|login] [--profile /absolute/root] [--mode device|browser]");
    }
  }
  return parsed;
}

export async function runLoginCli(args = process.argv.slice(2)): Promise<number> {
  let options: Arguments;
  try { options = parseArguments(args); } catch {
    console.error("Usage: npm run login -- [status|login] [--profile /absolute/root] [--mode device|browser]");
    return 2;
  }
  let profile;
  try { profile = activateProfile(resolveProfile(options.root)); } catch {
    console.error("Cannot activate the dedicated spike profile. Use a fresh directory or an existing initialized spike profile.");
    return 2;
  }
  if (options.command === "status") {
    console.log(JSON.stringify({ profile: profile.root, ...authStatus(profile) }, null, 2));
    return 0;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const status = await loginChatGpt(profile, {
      authMode: options.mode,
      signal: controller.signal,
      onAuth(info) {
        // Native authorization URL/device instructions are intended for the user.
        console.log(info.url);
        if (info.instructions) console.log(info.instructions);
      },
      async onPrompt(prompt) {
        return readline.question(prompt.message + " ", { signal: controller.signal });
      },
      // Progress is intentionally not echoed: provider messages may embed details.
    });
    console.log(JSON.stringify({ profile: profile.root, ...status }, null, 2));
    return 0;
  } catch (error) {
    console.error(safeAuthError(error));
    return 1;
  } finally {
    readline.close();
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLoginCli();
}
