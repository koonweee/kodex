import { Alert, Box, Group, Title } from "@mantine/core";
import { PanelLeftOpen } from "lucide-react";

import type { ProjectListEntry as Project } from "../threads/viewTypes";
import type { ProjectEditorActions } from "./controls";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { ProjectEditor } from "./ProjectEditor";

export function ProjectPane({
  onShowMobileSidebar,
  project,
  onDeleted,
  actions,
}: {
  onShowMobileSidebar: () => void;
  project: Project | null;
  onDeleted: () => void;
  actions?: ProjectEditorActions;
}) {
  const title = project?.name ?? "Project";

  return (
    <Box className="kodex-project-pane">
      <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-project-pane-header">
        <Group gap="xs" wrap="nowrap">
          <AdaptiveIconButton
            className="kodex-thread-sidebar-button"
            label="Show sidebar"
            onClick={onShowMobileSidebar}
          >
            <PanelLeftOpen />
          </AdaptiveIconButton>
          <Title className="kodex-thread-title" order={3} size="h5" title={title}>
            {title}
          </Title>
        </Group>
      </Group>
      {project ? (
        <Box className="kodex-project-pane-scroll">
          <ProjectEditor key={project.id} project={project} onDeleted={onDeleted} actions={actions} />
        </Box>
      ) : (
        <Alert color="gray" title="Project unavailable">
          This project could not be loaded from the gateway.
        </Alert>
      )}
    </Box>
  );
}
