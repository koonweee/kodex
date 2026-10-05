import { Alert, Box, Button, Group, Title } from "@mantine/core";

import type { Project } from "../api/client";
import { ProjectEditor } from "./ProjectEditor";

export function ProjectPane({
  onShowMobileSidebar,
  project,
  onDeleted,
}: {
  onShowMobileSidebar: () => void;
  project: Project | null;
  onDeleted: () => void;
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
          <ProjectEditor key={project.id} project={project} onDeleted={onDeleted} />
        </Box>
      ) : (
        <Alert color="gray" title="Project unavailable">
          This project could not be loaded from the gateway.
        </Alert>
      )}
    </Box>
  );
}
