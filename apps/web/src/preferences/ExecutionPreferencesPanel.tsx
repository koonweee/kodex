import { Alert, Badge, Box, Button, Group, Loader, SegmentedControl, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shield } from "lucide-react";
import { useState } from "react";

import { GatewayRequestError, getComposerSettings, listPermissionProfiles, persistComposerSettings, type ComposerSettingsUpdateRequest } from "../api/client";
import { refreshNativeConfig } from "../api/nativeConfigCache";
import { NativeConfigWriteFeedback } from "./NativeConfigWriteFeedback";
import { queryKeys } from "../api/queryKeys";

export function ExecutionPreferencesPanel() {
  const queryClient = useQueryClient();
  const [needsReview, setNeedsReview] = useState(false);
  const settings = useQuery({ queryKey: queryKeys.composerSettings(null), queryFn: ({ signal }) => getComposerSettings(null, null, signal) });
  const profiles = useQuery({ queryKey: queryKeys.permissionProfiles(null), queryFn: ({ signal }) => listPermissionProfiles(null, signal) });
  const mutation = useMutation({
    mutationFn: persistComposerSettings,
    onSuccess: async () => { await refreshNativeConfig(queryClient); },
    onError: async (error) => {
      if (error instanceof GatewayRequestError && error.code === "config_version_conflict") {
        setNeedsReview(true);
        await refreshNativeConfig(queryClient);
      }
    },
  });
  function save(fields: Omit<ComposerSettingsUpdateRequest, "writeTarget">) {
    const writeTarget = settings.data?.writeTarget;
    if (!writeTarget || needsReview || settings.error || mutation.isPending) return;
    mutation.mutate({ ...fields, writeTarget });
  }
  function setApprovalMode(mode: ExecutionApprovalMode) {
    const desired = approvalSettingsForMode(mode);
    const fields: Omit<ComposerSettingsUpdateRequest, "writeTarget"> = {};
    if (desired.approvalPolicy !== settings.data?.approvalPolicy) fields.approvalPolicy = desired.approvalPolicy;
    if (desired.approvalsReviewer !== settings.data?.approvalsReviewer) fields.approvalsReviewer = desired.approvalsReviewer;
    if (Object.keys(fields).length) save(fields);
  }
  return <Stack gap={12}>
    {needsReview ? <Alert color="yellow" variant="light">
      <Stack gap={8}>
        <Text size="sm">Native configuration changed elsewhere. Review the current values before choosing again.</Text>
        <Button disabled={settings.isFetching || Boolean(settings.error) || !settings.data?.writeTarget} onClick={() => { setNeedsReview(false); mutation.reset(); }} size="xs" variant="light">Review latest configuration</Button>
      </Stack>
    </Alert> : null}
    {mutation.data?.write ? <NativeConfigWriteFeedback write={mutation.data.write} notificationError={mutation.data.notificationError} /> : null}
    <ExecutionPreferencesControls
      profiles={profiles.data} profilesError={profiles.error} profilesLoading={profiles.isLoading}
      settings={settings.data} settingsError={settings.error} settingsLoading={settings.isLoading}
      saving={mutation.isPending} saveError={needsReview ? null : mutation.error}
      disabled={needsReview || !settings.data?.writeTarget || Boolean(settings.error)}
      onApprovalModeChange={setApprovalMode}
      onPermissionProfileChange={(permissionProfileId) => {
        if (permissionProfileId !== (settings.data?.permissionProfileId ?? null)) save({ permissionProfileId });
      }}
    />
    {settings.data && !settings.data.writeTarget ? <Text c="dimmed" size="sm">This native configuration has no editable user target.</Text> : null}
  </Stack>;
}

type ExecutionApprovalMode = "askMe" | "autoReview";
type ExecutionApprovalSelection = ExecutionApprovalMode | "requiresChoice";

function ExecutionPreferencesControls({
  profiles,
  profilesError,
  profilesLoading,
  saving,
  disabled,
  saveError,
  settings,
  settingsError,
  settingsLoading,
  onApprovalModeChange,
  onPermissionProfileChange,
}: {
  profiles?: Awaited<ReturnType<typeof listPermissionProfiles>>;
  profilesError: Error | null;
  profilesLoading: boolean;
  saving: boolean;
  disabled: boolean;
  saveError: Error | null;
  settings?: Awaited<ReturnType<typeof getComposerSettings>>;
  settingsError: Error | null;
  settingsLoading: boolean;
  onApprovalModeChange: (mode: ExecutionApprovalMode) => void;
  onPermissionProfileChange: (permissionProfileId: string | null) => void;
}) {
  const selectedPermissionProfileId = settings?.permissionProfileId ?? null;
  const approvalSelection = executionApprovalMode(settings?.approvalPolicy, settings?.approvalsReviewer);
  const loading = settingsLoading || profilesLoading;
  const error = settingsError ?? profilesError ?? saveError;
  const permissionOptions = [
    { id: null, label: "Default", description: "Use the configured Codex default scope." },
    ...(profiles ?? []).map((profile) => ({
      id: profile.id,
      label: permissionProfileLabel(profile.id, profile.label),
      description: profile.description ?? permissionProfileDescription(profile.id),
    })),
  ];

  return (
    <Stack className="kodex-preferences-panel kodex-execution-panel" gap={14}>
      <Group justify="space-between" wrap="nowrap">
        <Text className="kodex-preferences-panel-title" fw={650}>
          Execution
        </Text>
        <Badge data-tone={saving ? "info" : "neutral"}>{saving ? "Saving" : "Defaults"}</Badge>
      </Group>

      {loading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text c="dimmed" size="sm">
            Loading execution defaults
          </Text>
        </Group>
      ) : null}
      {error ? (
        <Alert color="red" variant="light">
          {error.message}
        </Alert>
      ) : null}

      <Stack className="kodex-preferences-setting" gap={10}>
        <Box className="kodex-preferences-setting-header">
          <Text fw={600} id="kodex-permission-scope-label" size="sm">
            Permission scope
          </Text>
          <Text c="dimmed" size="xs">
            Native defaults for new chats. Existing chats keep their shared settings.
          </Text>
        </Box>
        <Box aria-labelledby="kodex-permission-scope-label" className="kodex-execution-option-list" role="radiogroup">
          {permissionOptions.map((option) => {
            const selected = Boolean(settings) && option.id === selectedPermissionProfileId;
            return (
              <Button
                aria-checked={selected}
                className="kodex-execution-option"
                data-active={selected ? "true" : undefined}
                disabled={loading || saving || disabled}
                key={option.id ?? "default"}
                leftSection={selected ? <Check size={15} /> : <Shield size={15} />}
                onClick={() => onPermissionProfileChange(option.id)}
                role="radio"
                type="button"
                variant={selected ? "light" : "subtle"}
              >
                <Box className="kodex-execution-option-copy">
                  <Text fw={600} size="sm">
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text c="dimmed" size="xs">
                      {option.description}
                    </Text>
                  ) : null}
                </Box>
              </Button>
            );
          })}
        </Box>
      </Stack>

      <Stack className="kodex-preferences-setting" gap={10}>
        <Box className="kodex-preferences-setting-header">
          <Text fw={600} id="kodex-approval-review-label" size="sm">
            Approval review
          </Text>
          <Text c="dimmed" size="xs">
            Default reviewer for sandbox escapes, network requests, and similar approval prompts.
          </Text>
        </Box>
        {approvalSelection === "requiresChoice" ? (
          <Alert color="yellow" variant="light">
            Choose a review mode to replace the previous no-approval default.
          </Alert>
        ) : null}
        <SegmentedControl
          aria-labelledby="kodex-approval-review-label"
          className="kodex-execution-review-control"
          data={[
            { label: "Ask me", value: "askMe" },
            { label: "Auto review", value: "autoReview" },
          ]}
          disabled={loading || saving || disabled}
          onChange={(value) => onApprovalModeChange(value as ExecutionApprovalMode)}
          value={!settings || approvalSelection === "requiresChoice" ? "" : approvalSelection}
        />
      </Stack>
    </Stack>
  );
}

function approvalSettingsForMode(mode: ExecutionApprovalMode) {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: mode === "autoReview" ? "auto_review" : "user",
  };
}

function executionApprovalMode(
  approvalPolicy?: string | null,
  approvalsReviewer?: string | null,
): ExecutionApprovalSelection {
  if (approvalPolicy && approvalPolicy !== "on-request") {
    return "requiresChoice";
  }
  return approvalsReviewer === "auto_review" || approvalsReviewer === "guardian_subagent" ? "autoReview" : "askMe";
}

function permissionProfileLabel(id: string, label?: string | null): string {
  const normalized = id.replace(/^:/, "");
  switch (normalized) {
    case "read-only":
      return "Read only";
    case "workspace":
      return "Workspace";
    case "danger-full-access":
      return "Danger full access";
    default:
      return label || id;
  }
}

function permissionProfileDescription(id: string): string | null {
  const normalized = id.replace(/^:/, "");
  switch (normalized) {
    case "read-only":
      return "Read files without writing changes.";
    case "workspace":
      return "Write inside the current workspace and ask before leaving it.";
    case "danger-full-access":
      return "Run without sandbox restrictions on this local machine.";
    default:
      return null;
  }
}
