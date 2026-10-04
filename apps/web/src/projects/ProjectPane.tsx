import { Alert, Box, Button, Group, Text, Title } from "@mantine/core";

import type { Project } from "../api/client";

export function ProjectPane({
  onShowMobileSidebar,
  project,
}: {
  onShowMobileSidebar: () => void;
  project: Project | null;
}) {
  const title = project?.name ?? "Project";

  return (
    <Box className="kodex-project-pane">
      <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-project-pane-header">
        <Group gap="xs" wrap="nowrap">
          <Button className="kodex-thread-sidebar-button" onClick={onShowMobileSidebar} size="xs" variant="subtle">
            Projects
          </Button>
          <Title className="kodex-thread-title" order={3} size="h5" title={title}>
            {title}
          </Title>
        </Group>
      </Group>
      {project ? (
        <Box className="kodex-project-pane-scroll">
          <Text size="sm" c="dimmed" lineClamp={2}>
            {project.cwd}
          </Text>
        </Box>
      ) : (
        <Alert color="gray" title="Project unavailable">
          This project could not be loaded from the gateway.
        </Alert>
      )}
    </Box>
  );
}
