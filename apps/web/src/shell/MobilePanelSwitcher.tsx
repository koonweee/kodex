import { Box } from "@mantine/core";

export type MobilePanel = "threads" | "chat";

const MOBILE_TEXT = {
  chat: "Chat",
  label: "Mobile panels",
  threads: "Threads",
};

export function MobilePanelSwitcher({
  activePanel,
  onChange,
}: {
  activePanel: MobilePanel;
  onChange: (panel: MobilePanel) => void;
}) {
  const tabs: Array<{ label: string; panel: MobilePanel }> = [
    { label: MOBILE_TEXT.threads, panel: "threads" },
    { label: MOBILE_TEXT.chat, panel: "chat" },
  ];

  return (
    <Box aria-label={MOBILE_TEXT.label} className="kodex-mobile-switcher" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={activePanel === tab.panel}
          className="kodex-ui-button kodex-ui-selectable kodex-mobile-tab"
          data-active={activePanel === tab.panel}
          key={tab.panel}
          onClick={() => onChange(tab.panel)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </Box>
  );
}
