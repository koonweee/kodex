import { ActionIcon, Alert, Box, Button, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Folder, X } from "lucide-react";
import { useState } from "react";

import type { DirectoryLoader } from "./controls";
import { listDirectories } from "../api/client";
import { errorMessageFrom } from "../shared/values";

export function DirectoryPicker({ value, onChange, disabled, loadDirectories = listDirectories, queryScope }: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  loadDirectories?: DirectoryLoader;
  queryScope?: string;
}) {
  const [path, setPath] = useState<string>();
  const [previousPath, setPreviousPath] = useState<string>();
  const listing = useQuery({
    queryKey: queryScope ? ["directories", queryScope, path ?? "home"] : ["directories", path ?? "home"],
    queryFn: ({ signal }) => loadDirectories(path, signal),
    enabled: !value,
    retry: false,
    staleTime: 0,
  });
  const directory = listing.data;
  function navigate(next: string | undefined) {
    setPreviousPath(directory?.path);
    setPath(next);
  }
  return (
    <Stack gap="xs" role="group" aria-label="Root directory">
      <Text size="sm" fw={500}>Root directory</Text>
      {value ? (
        <Group wrap="nowrap" justify="space-between">
          <Text size="sm" style={{ overflowWrap: "anywhere" }}>{value}</Text>
          <ActionIcon aria-label="Remove root directory" variant="subtle" disabled={disabled} onClick={() => {
            setPath(value);
            onChange(null);
          }}><X size={16} /></ActionIcon>
        </Group>
      ) : (
        <>
          <Group wrap="nowrap">
            <ActionIcon aria-label="Go up" variant="default" disabled={disabled || !directory?.parentPath || listing.isFetching} onClick={() => navigate(directory?.parentPath ?? undefined)}><ArrowUp size={16} /></ActionIcon>
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>{directory?.path ?? path ?? "~/"}</Text>
          </Group>
          {listing.isFetching ? <Loader size="sm" aria-label="Loading directories" /> : null}
          {listing.error ? <Alert color="red" role="alert">{errorMessageFrom(listing.error)}<Button variant="subtle" size="compact-sm" onClick={() => void listing.refetch()}>Retry</Button>{previousPath ? <Button variant="subtle" size="compact-sm" onClick={() => { setPath(previousPath); setPreviousPath(undefined); }}>Back</Button> : null}</Alert> : null}
          {directory && !listing.isError && !listing.isFetching ? (
            <>
              <ScrollArea.Autosize mah={280}>
                <Stack gap={4}>
                  {directory.directories.map((child) => (
                    <Button key={child.name} variant="subtle" justify="start" leftSection={<Folder size={16} />} disabled={disabled} onClick={() => navigate(child.path)} styles={{ label: { whiteSpace: "normal", overflowWrap: "anywhere" } }}>{child.name}</Button>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              <Box><Button variant="light" disabled={disabled} onClick={() => onChange(directory.path)}>Use this directory</Button></Box>
            </>
          ) : null}
        </>
      )}
    </Stack>
  );
}
