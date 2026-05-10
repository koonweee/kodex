import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  createProjectPreview,
  createProjectPreviewRoute,
  createProjectPreviewService,
  deleteProjectPreview,
  deleteProjectPreviewRoute,
  deleteProjectPreviewService,
  getProjectPreviewSettings,
  reloadProjectPreviews,
  updateProjectPreview,
  type Project,
  type ProjectPreview,
  type ProjectPreviewService,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";

const DEFAULT_ROUTE_PATH = "/api/*";

export function ProjectPane({
  onShowMobileSidebar,
  project,
}: {
  onShowMobileSidebar: () => void;
  project: Project | null;
}) {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const projectId = project?.id ?? null;
  const settingsQuery = useQuery({
    enabled: projectId !== null,
    queryKey: projectId ? queryKeys.projectPreviews(projectId) : ["projects", "none", "previews"],
    queryFn: () => getProjectPreviewSettings(projectId!),
  });
  const settings = settingsQuery.data ?? null;

  function invalidate() {
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectPreviews(projectId) });
    }
  }

  function reportError(error: unknown) {
    setErrorMessage(errorMessageFrom(error));
  }

  const reloadMutation = useMutation({
    mutationFn: reloadProjectPreviews,
    onError: reportError,
    onSuccess: invalidate,
  });

  if (!project) {
    return (
      <Box className="kodex-project-pane">
        <ProjectPaneHeader onShowMobileSidebar={onShowMobileSidebar} title="Project" />
        <Alert color="gray" title="Project unavailable">
          This project could not be loaded from the gateway.
        </Alert>
      </Box>
    );
  }

  return (
    <Box className="kodex-project-pane">
      <ProjectPaneHeader onShowMobileSidebar={onShowMobileSidebar} title={project.name} />
      <Stack gap="md" className="kodex-project-pane-scroll">
        <Box>
          <Text size="sm" c="dimmed" lineClamp={2}>
            {project.cwd}
          </Text>
        </Box>
        {errorMessage ? (
          <Alert color="red" title="Preview change failed" withCloseButton onClose={() => setErrorMessage(null)}>
            {errorMessage}
          </Alert>
        ) : null}
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Text fw={600} size="sm">
              Preview subsystem
            </Text>
            <StatusBadge value={settings?.subsystem.state ?? (settingsQuery.isLoading ? "loading" : "unknown")} />
          </Group>
          <Button
            leftSection={<RefreshCw size={15} />}
            loading={reloadMutation.isPending}
            onClick={() => reloadMutation.mutate()}
            size="xs"
            variant="subtle"
          >
            Restart proxy
          </Button>
        </Group>
        {settings?.subsystem.lastReloadError ? (
          <Alert color="yellow" title="Proxy degraded">
            {settings.subsystem.lastReloadError}
          </Alert>
        ) : null}
        <ServicesSection
          onChanged={invalidate}
          onError={reportError}
          projectId={project.id}
          services={settings?.services ?? []}
        />
        <Divider />
        <PreviewsSection
          onChanged={invalidate}
          onError={reportError}
          previews={settings?.previews ?? []}
          projectId={project.id}
          services={settings?.services ?? []}
        />
      </Stack>
    </Box>
  );
}

function ProjectPaneHeader({
  onShowMobileSidebar,
  title,
}: {
  onShowMobileSidebar: () => void;
  title: string;
}) {
  return (
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
  );
}

function ServicesSection({
  onChanged,
  onError,
  projectId,
  services,
}: {
  onChanged: () => void;
  onError: (error: unknown) => void;
  projectId: string;
  services: ProjectPreviewService[];
}) {
  const [name, setName] = useState("");
  const [port, setPort] = useState<number | string>("");
  const [healthPath, setHealthPath] = useState("/");
  const createMutation = useMutation({
    mutationFn: () =>
      createProjectPreviewService(projectId, {
        healthPath,
        localPort: Number(port),
        name: name.trim() || `Service ${port}`,
        protocol: "http",
      }),
    onError,
    onSuccess: () => {
      setName("");
      setPort("");
      setHealthPath("/");
      onChanged();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4} size="h6">
          Services
        </Title>
      </Group>
      <form onSubmit={submit}>
        <Group align="end" gap="xs" className="kodex-project-preview-form">
          <TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Frontend" />
          <NumberInput label="Local port" min={1} max={65535} value={port} onChange={setPort} placeholder="3000" required />
          <TextInput label="Health path" value={healthPath} onChange={(event) => setHealthPath(event.currentTarget.value)} />
          <Button leftSection={<Plus size={15} />} loading={createMutation.isPending} type="submit">
            Add service
          </Button>
        </Group>
      </form>
      <Table.ScrollContainer minWidth={620}>
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Port</Table.Th>
              <Table.Th>Health</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {services.map((service) => (
              <ServiceRow key={service.id} onChanged={onChanged} onError={onError} projectId={projectId} service={service} />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

function ServiceRow({
  onChanged,
  onError,
  projectId,
  service,
}: {
  onChanged: () => void;
  onError: (error: unknown) => void;
  projectId: string;
  service: ProjectPreviewService;
}) {
  const deleteMutation = useMutation({
    mutationFn: () => deleteProjectPreviewService(projectId, service.id),
    onError,
    onSuccess: onChanged,
  });
  return (
    <Table.Tr>
      <Table.Td>{service.name}</Table.Td>
      <Table.Td>{service.localPort}</Table.Td>
      <Table.Td>{service.healthPath}</Table.Td>
      <Table.Td>
        <StatusBadge value={service.status.reachability} />
      </Table.Td>
      <Table.Td>
        <ActionIcon aria-label={`Delete ${service.name}`} loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()} variant="subtle">
          <Trash2 size={15} />
        </ActionIcon>
      </Table.Td>
    </Table.Tr>
  );
}

function PreviewsSection({
  onChanged,
  onError,
  previews,
  projectId,
  services,
}: {
  onChanged: () => void;
  onError: (error: unknown) => void;
  previews: ProjectPreview[];
  projectId: string;
  services: ProjectPreviewService[];
}) {
  const [name, setName] = useState("");
  const [rootServiceId, setRootServiceId] = useState<string | null>(null);
  const [publicPort, setPublicPort] = useState<number | string>("");
  const createMutation = useMutation({
    mutationFn: () =>
      createProjectPreview(projectId, {
        name: name.trim() || "App",
        publicPort: typeof publicPort === "number" ? publicPort : null,
        rootServiceId: rootServiceId ?? "",
      }),
    onError,
    onSuccess: () => {
      setName("");
      setRootServiceId(null);
      setPublicPort("");
      onChanged();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate();
  }

  const serviceOptions = services.map((service) => ({ label: `${service.name} :${service.localPort}`, value: service.id }));

  return (
    <Stack gap="sm">
      <Title order={4} size="h6">
        Previews
      </Title>
      <form onSubmit={submit}>
        <Group align="end" gap="xs" className="kodex-project-preview-form">
          <TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="App" />
          <Select label="Root service" data={serviceOptions} value={rootServiceId} onChange={setRootServiceId} required />
          <Tooltip label="Remote tailnet-facing port Caddy listens on. Leave blank to use 10000 plus the root service port when available.">
            <NumberInput label="Public port" min={10000} max={19999} value={publicPort} onChange={setPublicPort} placeholder="Auto" />
          </Tooltip>
          <Button leftSection={<Plus size={15} />} loading={createMutation.isPending} type="submit">
            Add preview
          </Button>
        </Group>
      </form>
      <Stack gap="sm">
        {previews.map((preview) => (
          <PreviewCard
            key={preview.id}
            onChanged={onChanged}
            onError={onError}
            preview={preview}
            projectId={projectId}
            services={services}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function PreviewCard({
  onChanged,
  onError,
  preview,
  projectId,
  services,
}: {
  onChanged: () => void;
  onError: (error: unknown) => void;
  preview: ProjectPreview;
  projectId: string;
  services: ProjectPreviewService[];
}) {
  const [routeServiceId, setRouteServiceId] = useState<string | null>(null);
  const [routePath, setRoutePath] = useState(DEFAULT_ROUTE_PATH);
  const [stripPrefix, setStripPrefix] = useState(true);
  const updateMutation = useMutation({
    mutationFn: (enabled: boolean) => updateProjectPreview(projectId, preview.id, { enabled }),
    onError,
    onSuccess: onChanged,
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteProjectPreview(projectId, preview.id),
    onError,
    onSuccess: onChanged,
  });
  const routeMutation = useMutation({
    mutationFn: () =>
      createProjectPreviewRoute(projectId, preview.id, {
        pathPattern: routePath,
        serviceId: routeServiceId ?? "",
        stripPrefix,
      }),
    onError,
    onSuccess: () => {
      setRoutePath(DEFAULT_ROUTE_PATH);
      setRouteServiceId(null);
      setStripPrefix(true);
      onChanged();
    },
  });

  const root = services.find((service) => service.id === preview.rootServiceId);
  const serviceOptions = services.map((service) => ({ label: `${service.name} :${service.localPort}`, value: service.id }));

  function submitRoute(event: FormEvent) {
    event.preventDefault();
    routeMutation.mutate();
  }

  return (
    <Box className="kodex-project-preview-card">
      <Group justify="space-between" align="start" gap="sm">
        <Box>
          <Group gap="xs">
            <Text fw={600}>{preview.name}</Text>
            <StatusBadge value={preview.status.state} />
          </Group>
          <Text size="sm" c="dimmed">
            {`/ -> ${root ? `${root.name} :${root.localPort}` : "Missing service"}`}
          </Text>
          {preview.status.url ? (
            <Button
              component="a"
              href={preview.status.url}
              leftSection={<ExternalLink size={15} />}
              mt="xs"
              rel="noreferrer"
              size="xs"
              target="_blank"
              variant="light"
            >
              Open {preview.status.url}
            </Button>
          ) : null}
        </Box>
        <Group gap="xs">
          <Checkbox
            checked={preview.enabled}
            label="Enabled"
            onChange={(event) => updateMutation.mutate(event.currentTarget.checked)}
          />
          <ActionIcon aria-label={`Delete ${preview.name}`} loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()} variant="subtle">
            <Trash2 size={15} />
          </ActionIcon>
        </Group>
      </Group>
      {preview.status.lastReloadError ? (
        <Alert color="yellow" mt="sm" title="Preview degraded">
          {preview.status.lastReloadError}
        </Alert>
      ) : null}
      <Table.ScrollContainer minWidth={620} mt="sm">
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Tooltip label="Browser path prefix routed away from the root service.">
                  <Group gap={4}>Path <Info size={13} /></Group>
                </Tooltip>
              </Table.Th>
              <Table.Th>Service</Table.Th>
              <Table.Th>
                <Tooltip label="When enabled, /api/users reaches the backend as /users. When disabled, it remains /api/users.">
                  <Group gap={4}>Strip prefix <Info size={13} /></Group>
                </Tooltip>
              </Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {preview.routes.map((route) => (
              <PreviewRouteRow
                key={route.id}
                onChanged={onChanged}
                onError={onError}
                previewId={preview.id}
                projectId={projectId}
                route={route}
                services={services}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <form onSubmit={submitRoute}>
        <Group align="end" gap="xs" mt="sm" className="kodex-project-preview-form">
          <TextInput label="Route path" value={routePath} onChange={(event) => setRoutePath(event.currentTarget.value)} />
          <Select label="Target service" data={serviceOptions} value={routeServiceId} onChange={setRouteServiceId} required />
          <Checkbox checked={stripPrefix} label="Strip prefix" onChange={(event) => setStripPrefix(event.currentTarget.checked)} />
          <Button leftSection={<Plus size={15} />} loading={routeMutation.isPending} type="submit" variant="light">
            Add route
          </Button>
        </Group>
      </form>
    </Box>
  );
}

function PreviewRouteRow({
  onChanged,
  onError,
  previewId,
  projectId,
  route,
  services,
}: {
  onChanged: () => void;
  onError: (error: unknown) => void;
  previewId: string;
  projectId: string;
  route: ProjectPreview["routes"][number];
  services: ProjectPreviewService[];
}) {
  const deleteMutation = useMutation({
    mutationFn: () => deleteProjectPreviewRoute(projectId, previewId, route.id),
    onError,
    onSuccess: onChanged,
  });
  const service = services.find((candidate) => candidate.id === route.serviceId);
  return (
    <Table.Tr>
      <Table.Td>{route.pathPattern}</Table.Td>
      <Table.Td>{service ? `${service.name} :${service.localPort}` : "Missing service"}</Table.Td>
      <Table.Td>{route.stripPrefix ? "Yes" : "No"}</Table.Td>
      <Table.Td>
        <ActionIcon aria-label={`Delete route ${route.pathPattern}`} loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()} variant="subtle">
          <Trash2 size={15} />
        </ActionIcon>
      </Table.Td>
    </Table.Tr>
  );
}

function StatusBadge({ value }: { value: string }) {
  const color =
    value === "active" || value === "available" || value === "reachable"
      ? "green"
      : value === "disabled" || value === "unknown" || value === "loading"
        ? "gray"
        : "yellow";
  return (
    <Badge color={color} radius="sm" size="sm" variant="light">
      {value}
    </Badge>
  );
}
