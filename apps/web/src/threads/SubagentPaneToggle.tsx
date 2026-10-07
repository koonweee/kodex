import { Bot } from "lucide-react";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

export function SubagentPaneToggle({ visible, open, onToggle }: {
  visible: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <span style={{ display: "inline-flex", visibility: visible ? undefined : "hidden" }} inert={!visible} aria-hidden={!visible}>
      <AdaptiveIconButton
        aria-pressed={open}
        label={open ? "Hide subagents" : "Show subagents"}
        onClick={onToggle}
        variant={open ? "light" : "subtle"}
      ><Bot /></AdaptiveIconButton>
    </span>
  );
}
