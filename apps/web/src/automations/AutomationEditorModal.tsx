import {
  Alert,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AlertCircle, Pause, Play, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  Automation,
  AutomationCreateRequest,
  AutomationUpdateRequest,
} from "../api/client";
import {
  automationFormValues,
  automationValidationError,
  startAtIsoFromLocalInput,
  type AutomationFormValues,
} from "./schedule";
import type { AutomationThreadOption } from "./threadOptions";
import { PromptMarkdownEditor } from "./PromptMarkdownEditor";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

const REPEAT_UNIT_OPTIONS = [
  { label: "Seconds", value: "seconds" },
  { label: "Minutes", value: "minutes" },
  { label: "Hours", value: "hours" },
];

export function AutomationEditorModal({
  automation,
  fallbackThreadId,
  onClose,
  onCreate,
  onDelete,
  onPause,
  onResume,
  onUpdate,
  opened,
  threadOptions,
}: {
  automation: Automation | null;
  fallbackThreadId: string | null;
  onClose: () => void;
  onCreate: (request: AutomationCreateRequest) => Promise<Automation>;
  onDelete: (automationId: string) => Promise<void>;
  onPause: (automationId: string) => Promise<void>;
  onResume: (automationId: string) => Promise<void>;
  onUpdate: (automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
  opened: boolean;
  threadOptions: AutomationThreadOption[];
}) {
  const [values, setValues] = useState<AutomationFormValues>(() => automationFormValues(automation, fallbackThreadId));
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [deletePendingConfirmation, setDeletePendingConfirmation] = useState(false);
  const [mobileTab, setMobileTab] = useState<"details" | "prompt">("details");
  const [error, setError] = useState<string | null>(null);
  const title = automation ? "Automation details" : "New automation";
  const isSubmitting = submittingAction !== null;
  const isMobileModal = useMediaQuery("(max-width: 700px)");
  const selectedThreadExists = values.targetThreadId
    ? threadOptions.some((option) => option.value === values.targetThreadId)
    : true;
  const targetThreadOptions = useMemo(() => {
    if (!values.targetThreadId || selectedThreadExists) {
      return threadOptions;
    }
    return [{ label: values.targetThreadId, value: values.targetThreadId }, ...threadOptions];
  }, [selectedThreadExists, threadOptions, values.targetThreadId]);

  useEffect(() => {
    if (opened) {
      setValues(automationFormValues(automation, fallbackThreadId));
      setError(null);
      setDeletePendingConfirmation(false);
      setSubmittingAction(null);
      setMobileTab("details");
    }
  }, [automation, fallbackThreadId, opened]);

  async function handleSave() {
    const validationError = automationValidationError(values);
    if (validationError) {
      setError(validationError);
      return;
    }
    const startAt = startAtIsoFromLocalInput(values.startAtLocal);
    if (!startAt || !values.targetThreadId) {
      return;
    }

    const schedule = {
      startAt,
      repeatEvery: {
        value: values.repeatValue,
        unit: values.repeatUnit,
      },
    };
    setSubmittingAction("save");
    setError(null);
    try {
      if (automation) {
        await onUpdate(automation.id, {
          name: values.name.trim(),
          prompt: values.prompt.trim(),
          targetThreadId: values.targetThreadId,
          schedule,
        });
      } else {
        await onCreate({
          name: values.name.trim(),
          prompt: values.prompt.trim(),
          targetThreadId: values.targetThreadId,
          schedule,
        });
      }
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmittingAction(null);
    }
  }

  async function handleAction(action: "delete" | "pause" | "resume") {
    if (!automation) {
      return;
    }
    if (action === "delete" && !deletePendingConfirmation) {
      setDeletePendingConfirmation(true);
      return;
    }
    setSubmittingAction(action);
    setError(null);
    try {
      if (action === "delete") {
        await onDelete(automation.id);
        onClose();
      } else if (action === "pause") {
        await onPause(automation.id);
      } else {
        await onResume(automation.id);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmittingAction(null);
    }
  }

  function patchValues(patch: Partial<AutomationFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  const detailsFields = (
    <div className="kodex-automation-modal-grid">
      <TextInput
        className="kodex-automation-mobile-input"
        label="Name"
        onChange={(event) => patchValues({ name: event.currentTarget.value })}
        required
        value={values.name}
      />
      <Select
        className="kodex-automation-mobile-input"
        comboboxProps={{ width: "target" }}
        data={targetThreadOptions}
        label="Target thread"
        onChange={(value) => patchValues({ targetThreadId: value })}
        renderOption={({ option }) => (
          <Text
            component="span"
            truncate="end"
            title={option.label}
            style={{ display: "block", flex: "1 1 0", minWidth: 0, width: "100%" }}
          >
            {option.label}
          </Text>
        )}
        required
        scrollAreaProps={{
          scrollbars: "y",
          styles: {
            content: { display: "block", minWidth: 0, width: "100%" },
            viewport: { overflowX: "hidden" },
          },
        }}
        searchable
        styles={{
          option: { minWidth: 0, width: "100%", maxWidth: "100%", overflow: "hidden" },
        }}
        value={values.targetThreadId}
      />
      <TextInput
        className="kodex-automation-mobile-input"
        label="Start"
        onChange={(event) => patchValues({ startAtLocal: event.currentTarget.value })}
        required
        type="datetime-local"
        value={values.startAtLocal}
      />
      <div className="kodex-automation-repeat-row">
        <NumberInput
          className="kodex-automation-mobile-input"
          hideControls
          label="Repeat every"
          min={1}
          onChange={(value) => patchValues({ repeatValue: Number(value) || 0 })}
          required
          value={values.repeatValue}
          inputMode="numeric"
        />
        <Select
          aria-label="Repeat unit"
          className="kodex-automation-mobile-input"
          data={REPEAT_UNIT_OPTIONS}
          onChange={(value) => {
            if (value === "seconds" || value === "minutes" || value === "hours") {
              patchValues({ repeatUnit: value });
            }
          }}
          value={values.repeatUnit}
        />
      </div>
    </div>
  );
  const promptFields = (showLabel = true) => (
    <Stack className="kodex-automation-modal-prompt-section" gap={6}>
      {showLabel ? (
        <Text fw={500} size="sm">
          Prompt
        </Text>
      ) : null}
      <PromptMarkdownEditor value={values.prompt} onChange={(prompt) => patchValues({ prompt })} />
    </Stack>
  );

  return (
    <Modal
      centered={!isMobileModal}
      className="kodex-automation-modal"
      fullScreen={isMobileModal}
      onClose={onClose}
      opened={opened}
      size="xl"
      title={title}
    >
      <Stack className="kodex-automation-modal-form" gap="md">
        {error ? (
          <Alert color="red" icon={<AlertCircle size={16} />}>
            {error}
          </Alert>
        ) : null}
        {isMobileModal ? (
          <Tabs
            className="kodex-automation-modal-tabs"
            keepMounted={false}
            onChange={(value) => {
              if (value === "details" || value === "prompt") {
                setMobileTab(value);
              }
            }}
            value={mobileTab}
          >
            <Tabs.List grow>
              <Tabs.Tab value="details">Details</Tabs.Tab>
              <Tabs.Tab value="prompt">Prompt</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel className="kodex-automation-modal-tab-panel" value="details">
              {detailsFields}
            </Tabs.Panel>
            <Tabs.Panel
              className="kodex-automation-modal-tab-panel kodex-automation-modal-prompt-panel"
              value="prompt"
            >
              {promptFields(false)}
            </Tabs.Panel>
          </Tabs>
        ) : (
          <>
            {detailsFields}
            {promptFields()}
          </>
        )}
        <Group className="kodex-automation-modal-footer" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            {automation ? (
              <>
                <AdaptiveIconButton
                  color="red"
                  disabled={isSubmitting}
                  label={deletePendingConfirmation ? "Confirm delete" : "Delete"}
                  loading={submittingAction === "delete"}
                  onClick={() => void handleAction("delete")}
                  variant={deletePendingConfirmation ? "filled" : "subtle"}
                >
                  <Trash2 />
                </AdaptiveIconButton>
                <AdaptiveIconButton
                  className="kodex-automation-status-action"
                  disabled={isSubmitting}
                  label={automation.status === "paused" ? "Resume" : "Pause"}
                  loading={submittingAction === "pause" || submittingAction === "resume"}
                  onClick={() => void handleAction(automation.status === "paused" ? "resume" : "pause")}

                >
                  {automation.status === "paused" ? <Play /> : <Pause />}
                </AdaptiveIconButton>
              </>
            ) : null}
          </Group>
          <Group gap="xs" wrap="nowrap">
            <AdaptiveIconButton label="Save" loading={submittingAction === "save"} onClick={() => void handleSave()} variant="filled">
              <Save />
            </AdaptiveIconButton>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
