import { Box, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function EmptyPanel({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <Box className="kodex-empty">
      <Box className="kodex-empty-icon" aria-hidden="true">
        {icon}
      </Box>
      <Text fw={700} size="sm">
        {title}
      </Text>
      <Text size="sm" c="dimmed">
        {text}
      </Text>
    </Box>
  );
}
