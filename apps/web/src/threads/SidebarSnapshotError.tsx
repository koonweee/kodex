import { Alert, Button } from "@mantine/core";

export type SidebarSnapshotStatus = {
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
};

export function SidebarSnapshotError({ status }: { status?: SidebarSnapshotStatus }) {
  if (!status?.failed) return null;
  return (
    <Alert color="red" title="Could not load sidebar">
      <Button variant="subtle" size="compact-sm" loading={status.retrying} onClick={status.onRetry}>
        Retry
      </Button>
    </Alert>
  );
}
