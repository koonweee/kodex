import { replaceComposerTriggerToken, type ComposerTriggerToken } from "./composerTriggers";

export type SlashCommandId = "compact";

export type SlashCommandItem = {
  description: string;
  disabledReason?: string;
  id: SlashCommandId;
  label: string;
  token: `/${SlashCommandId}`;
};

const SLASH_COMMANDS: Omit<SlashCommandItem, "disabledReason">[] = [
  {
    description: "Summarize conversation to prevent hitting the context limit",
    id: "compact",
    label: "Compact",
    token: "/compact",
  },
];

export function slashCommandItems({
  canCompact,
  compactDisabledReason,
}: {
  canCompact: boolean;
  compactDisabledReason: string;
}): SlashCommandItem[] {
  return SLASH_COMMANDS.map((command) => ({
    ...command,
    disabledReason: command.id === "compact" && !canCompact ? compactDisabledReason : undefined,
  }));
}

export function filterSlashCommands(commands: SlashCommandItem[], query: string): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return commands;
  }
  return commands.filter((command) => {
    const commandName = command.token.slice(1).toLocaleLowerCase();
    return (
      commandName.includes(normalizedQuery) ||
      command.label.toLocaleLowerCase().includes(normalizedQuery) ||
      command.description.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

export function slashCommandFromSubmittedText(text: string): SlashCommandId | "unknown" | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const commandMatch = /^\/([A-Za-z0-9_-]+)(?:\s|$)/.exec(trimmed);
  if (!commandMatch) {
    return null;
  }
  const commandToken = `/${commandMatch[1]}`;
  const command = SLASH_COMMANDS.find((item) => item.token === commandToken);
  return command && command.token === trimmed ? command.id : "unknown";
}

export function replaceSlashCommandToken(
  text: string,
  token: ComposerTriggerToken<"/">,
  command: SlashCommandItem,
): { cursor: number; text: string } {
  return replaceComposerTriggerToken(text, token, command.token);
}
