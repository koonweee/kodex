import { Menu } from "@mantine/core";
import { Check, Monitor } from "lucide-react";
import type { DesktopDisplay } from "../../desktop/bridge";
import { AdaptiveIconButton } from "../../ui/AdaptiveIconButton";

export function DesktopDisplayMenu({ displays, selected, disabled, opened, onChange, onSelect }: {
  displays: DesktopDisplay[]; selected: number | undefined; disabled: boolean; opened: boolean; onChange: (opened: boolean) => void; onSelect: (id: number) => void;
}) {
  const current = displays.find((display) => display.id === selected)?.name ?? "Select display";
  return <Menu withinPortal position="bottom-end" opened={opened} onChange={onChange}>
    <Menu.Target><AdaptiveIconButton label={`Desktop display: ${current}`} disabled={disabled} tooltip={false}><Monitor /></AdaptiveIconButton></Menu.Target>
    <Menu.Dropdown>
      <Menu.Label>Display</Menu.Label>
      {displays.map((display) => <Menu.Item key={display.id} aria-current={selected === display.id ? "true" : undefined}
        leftSection={selected === display.id ? <Check size={14} /> : undefined} onClick={() => onSelect(display.id)}>{display.name}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu>;
}
