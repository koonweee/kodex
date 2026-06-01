import { Terminal } from "lucide-react";

import { MobileTriggerCommandSheet } from "./MobileTriggerCommandSheet";
import type { SlashCommandItem } from "./slashCommands";
import type { TriggerSuggestionItem } from "./TriggerSuggestionPopup";

type MobileSlashCommandSheetProps = {
  activeIndex: number;
  commands: SlashCommandItem[];
  onSelect: (command: SlashCommandItem) => void;
};

export function MobileSlashCommandSheet({
  activeIndex,
  commands,
  onSelect,
}: MobileSlashCommandSheetProps) {
  return (
    <MobileTriggerCommandSheet
      activeIndex={activeIndex}
      ariaLabel="Slash command suggestions"
      emptyLabel="No matching commands"
      itemClassName="kodex-mobile-skill-command-row kodex-mobile-slash-command-row"
      items={commands.map(slashCommandSuggestionItem)}
      onSelect={(item) => onSelect(item.command)}
      renderItem={(item) => <MobileSlashCommandContent command={item.command} />}
    />
  );
}

type SlashCommandSuggestionItem = TriggerSuggestionItem & {
  command: SlashCommandItem;
};

function slashCommandSuggestionItem(command: SlashCommandItem): SlashCommandSuggestionItem {
  return {
    disabled: Boolean(command.disabledReason),
    id: command.id,
    command,
  };
}

function MobileSlashCommandContent({ command }: { command: SlashCommandItem }) {
  return (
    <>
      <span aria-hidden="true" className="kodex-skill-option-icon kodex-slash-command-icon">
        <Terminal size={16} />
      </span>
      <span className="kodex-mobile-skill-command-copy kodex-mobile-slash-command-copy">
        <span className="kodex-mobile-skill-command-name">{command.token}</span>
        <span className="kodex-mobile-skill-command-token">
          {command.disabledReason ?? command.description}
        </span>
      </span>
    </>
  );
}
