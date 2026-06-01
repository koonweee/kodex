import { Terminal } from "lucide-react";

import type { SlashCommandItem } from "./slashCommands";
import { TriggerSuggestionPopup, type TriggerSuggestionItem } from "./TriggerSuggestionPopup";

type SlashCommandPopupProps = {
  activeIndex: number;
  commands: SlashCommandItem[];
  onSelect: (command: SlashCommandItem) => void;
};

export function SlashCommandPopup({ activeIndex, commands, onSelect }: SlashCommandPopupProps) {
  return (
    <TriggerSuggestionPopup
      activeIndex={activeIndex}
      ariaLabel="Slash command suggestions"
      emptyLabel="No matching commands"
      itemClassName="kodex-skill-popup-row kodex-slash-command-row"
      items={commands.map(slashCommandSuggestionItem)}
      onSelect={(item) => onSelect(item.command)}
      renderItem={(item) => <SlashCommandContent command={item.command} />}
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

function SlashCommandContent({ command }: { command: SlashCommandItem }) {
  return (
    <>
      <span aria-hidden="true" className="kodex-skill-option-icon kodex-slash-command-icon">
        <Terminal size={16} />
      </span>
      <span className="kodex-skill-popup-body">
        <span className="kodex-skill-popup-title kodex-slash-command-title">
          <span className="kodex-skill-popup-name">{command.token}</span>
          {command.disabledReason ? <span className="kodex-skill-popup-scope">Unavailable</span> : null}
        </span>
        <span className="kodex-skill-popup-meta kodex-slash-command-meta">
          {command.disabledReason ?? command.description}
        </span>
      </span>
    </>
  );
}
