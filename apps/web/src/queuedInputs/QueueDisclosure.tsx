import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Box, Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { usePaneLayout } from "../shared/PaneLayout";

export function QueueDisclosure({ count, partial, children }: { count: number; partial: boolean; children: ReactNode }) {
  const { short } = usePaneLayout();
  // Disclosure is intentionally local to this pane; native queue contents stay authoritative.
  const [choice, setChoice] = useState<boolean | null>(null);
  const contentId = useId();
  const collapsed = count > 1 && (choice ?? short);
  return <Box role="region" aria-label="Queued messages" className="kodex-queued-messages">
    {count > 1 ? <div className={collapsed ? undefined : "kodex-queue-collapse-zone"}>
      <Button variant="subtle" color="gray" className={collapsed ? "kodex-queue-summary" : "kodex-queue-collapse"}
        aria-label={collapsed ? undefined : "Collapse queued messages"}
        aria-expanded={!collapsed} aria-controls={contentId}
        rightSection={collapsed ? <ChevronUp size={16} /> : undefined}
        onClick={() => setChoice(!collapsed)}>
        {collapsed ? <AnimatedNumericText text={`${count}${partial ? "+" : ""} queued messages`} /> : <ChevronDown size={16} />}
      </Button>
    </div> : null}
    <div id={contentId}>{collapsed ? null : children}</div>
  </Box>;
}
