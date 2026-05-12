import { Alert, Anchor, Box, Button, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { ExternalLink, FileText, KeyRound } from "lucide-react";

import { readMcpResource, type ConfiguredMcpServer, type McpResource, type McpServerStatus } from "../api/client";
import { authLabel } from "./mcpTypes";

type McpServerDetailProps = {
  configured?: ConfiguredMcpServer;
  oauthError?: string;
  oauthLoading: boolean;
  oauthUrl: string | null;
  onDisable: () => void;
  onEnable: () => void;
  onLogin: () => void;
  onReadResource: (resource: McpResource) => void;
  onRemove: () => void;
  onReplace: () => void;
  resource: McpResource | null;
  resourceError?: string;
  resourceLoading: boolean;
  resourceResponse?: Awaited<ReturnType<typeof readMcpResource>>;
  removeConfirming: boolean;
  server?: McpServerStatus;
  serverName: string;
};

export function McpServerDetail({
  configured,
  oauthError,
  oauthLoading,
  oauthUrl,
  onDisable,
  onEnable,
  onLogin,
  onReadResource,
  onRemove,
  onReplace,
  resource,
  resourceError,
  resourceLoading,
  resourceResponse,
  removeConfirming,
  server,
  serverName,
}: McpServerDetailProps) {
  const toolNames = Object.keys(server?.tools ?? {}).sort();
  return (
    <Stack className="kodex-mcp-detail" gap={12}>
      <Group justify="space-between" wrap="wrap">
        <Box>
          <Text fw={650} size="sm">
            {serverName}
          </Text>
          <Text c="dimmed" size="xs">
            {server ? authLabel(server.authStatus) : "Configured"}
          </Text>
        </Box>
        <Group gap={6}>
          {configured ? (
            <>
              <Button onClick={onReplace} size="xs" type="button" variant="subtle">
                Replace
              </Button>
              <Button onClick={configured.enabled ? onDisable : onEnable} size="xs" type="button" variant="subtle">
                {configured.enabled ? "Disable" : "Enable"}
              </Button>
              <Button color="red" onClick={onRemove} size="xs" type="button" variant={removeConfirming ? "light" : "subtle"}>
                {removeConfirming ? "Confirm remove" : "Remove"}
              </Button>
            </>
          ) : null}
          {server && (server.authStatus === "notLoggedIn" || server.authStatus === "oAuth") ? (
            <Button leftSection={<KeyRound size={15} />} loading={oauthLoading} onClick={onLogin} size="xs" type="button" variant="light">
              Log in
            </Button>
          ) : null}
        </Group>
      </Group>

      {configured?.hasStoredSecrets ? (
        <Alert color="yellow" variant="light">
          This server has stored env/header values in local Codex config. Values are hidden in Kodex.
        </Alert>
      ) : null}

      {oauthError ? (
        <Alert color="red" variant="light">
          {oauthError}
        </Alert>
      ) : null}
      {oauthUrl ? (
        <Alert color="blue" variant="light">
          <Group gap={8} justify="space-between" wrap="nowrap">
            <Text size="sm">Authorization is ready.</Text>
            <Anchor href={oauthUrl} rel="noreferrer" target="_blank">
              <Group gap={4} wrap="nowrap">
                <Text size="sm">Open login</Text>
                <ExternalLink size={14} />
              </Group>
            </Anchor>
          </Group>
        </Alert>
      ) : null}

      <Box>
        <Text fw={650} size="xs">
          Tools
        </Text>
        {toolNames.length ? (
          <Text c="dimmed" size="xs">
            {toolNames.join(", ")}
          </Text>
        ) : (
          <Text c="dimmed" size="xs">
            No tools reported
          </Text>
        )}
      </Box>

      <Box>
        <Text fw={650} size="xs">
          Resources
        </Text>
        {server?.resources.length ? (
          <Stack gap={6} mt={6}>
            {server.resources.map((item) => (
              <Button
                className="kodex-mcp-resource-row"
                key={item.uri}
                leftSection={<FileText size={14} />}
                onClick={() => onReadResource(item)}
                size="xs"
                type="button"
                variant={resource?.uri === item.uri ? "light" : "subtle"}
              >
                {item.title ?? item.name} ({item.uri})
              </Button>
            ))}
          </Stack>
        ) : (
          <Text c="dimmed" size="xs">
            No concrete resources reported
          </Text>
        )}
      </Box>

      <Box>
        <Text fw={650} size="xs">
          Resource templates
        </Text>
        {server?.resourceTemplates.length ? (
          <Text c="dimmed" size="xs">
            {server.resourceTemplates.map((template) => template.title ?? template.name).join(", ")}
          </Text>
        ) : (
          <Text c="dimmed" size="xs">
            No templates reported
          </Text>
        )}
      </Box>

      {resource ? (
        <Box className="kodex-mcp-resource-preview">
          <Text fw={650} size="xs">
            {resource.title ?? resource.name}
          </Text>
          <Text c="dimmed" size="xs">
            {resource.uri}
          </Text>
          {resourceLoading ? (
            <Group gap={8} mt={8}>
              <Loader size={14} />
              <Text c="dimmed" size="xs">
                Reading resource
              </Text>
            </Group>
          ) : null}
          {resourceError ? (
            <Alert color="red" mt={8} variant="light">
              {resourceError}
            </Alert>
          ) : null}
          {resourceResponse ? (
            <ScrollArea.Autosize mah={220} mt={8} type="auto">
              <pre className="kodex-mcp-resource-content">{formatResourceContents(resourceResponse.contents)}</pre>
            </ScrollArea.Autosize>
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
}

function formatResourceContents(contents: unknown[]): string {
  return contents
    .map((content) => {
      if (isTextContent(content)) {
        return content.text;
      }
      if (isBlobContent(content)) {
        return formatBlobContent(content);
      }
      return JSON.stringify(content, null, 2);
    })
    .join("\n\n");
}

function isTextContent(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";
}

function isBlobContent(value: unknown): value is { blob: string; mimeType?: string | null; uri?: string } {
  return typeof value === "object" && value !== null && "blob" in value && typeof value.blob === "string";
}

function formatBlobContent(content: { blob: string; mimeType?: string | null; uri?: string }) {
  return [
    "Unsupported binary resource",
    content.uri ? `URI: ${content.uri}` : null,
    content.mimeType ? `MIME type: ${content.mimeType}` : null,
    `Encoded payload length: ${content.blob.length} characters`,
  ]
    .filter(Boolean)
    .join("\n");
}
