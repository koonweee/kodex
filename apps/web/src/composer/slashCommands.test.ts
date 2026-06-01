import { describe, expect, it } from "vitest";

import { filterSlashCommands, slashCommandFromSubmittedText, slashCommandItems } from "./slashCommands";

describe("slash command helpers", () => {
  it("filters commands by token, label, and description", () => {
    const commands = slashCommandItems({ canCompact: true, compactDisabledReason: "Thread is busy" });

    expect(filterSlashCommands(commands, "co").map((command) => command.id)).toEqual(["compact"]);
    expect(filterSlashCommands(commands, "summarize").map((command) => command.id)).toEqual(["compact"]);
    expect(filterSlashCommands(commands, "missing")).toEqual([]);
  });

  it("detects submitted slash commands only from command-shaped first tokens", () => {
    expect(slashCommandFromSubmittedText("/compact")).toBe("compact");
    expect(slashCommandFromSubmittedText("  /compact  ")).toBe("compact");
    expect(slashCommandFromSubmittedText("/compact now")).toBe("unknown");
    expect(slashCommandFromSubmittedText("/nope")).toBe("unknown");
    expect(slashCommandFromSubmittedText("/nope please")).toBe("unknown");
    expect(slashCommandFromSubmittedText("Please run /compact")).toBeNull();
    expect(slashCommandFromSubmittedText("/")).toBeNull();
  });
});
