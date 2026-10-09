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
import { useCompactDialog } from "../shared/layoutBreakpoints";
import { AlertCircle, Pause, Play, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

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
import { AutomationRuns } from "./AutomationRuns";
import { PromptMarkdownEditor } from "./PromptMarkdownEditor";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

import type { NativeAutomation, NativeAutomationInput } from "../mastra/nativeAutomationTypes";
import { nativeAutomationScheduleDraft, nativeAutomationScheduleError } from "../mastra/nativeAutomationForm";
import { NativeAutomationScheduleFields } from "../mastra/NativeAutomationScheduleFields";

type EditorCommonProps = {
  fallbackThreadId: string | null;
  onClose: () => void;
  onDelete: (automationId: string) => Promise<void>;
  onPause: (automationId: string) => Promise<void>;
  onResume: (automationId: string) => Promise<void>;
  opened: boolean;
  threadOptions: AutomationThreadOption[];
  renderRuns?: (automationId: string) => ReactNode;
};
export type CalendarAutomationEditorProps = EditorCommonProps & {
  mode: "calendar";
  automation: NativeAutomation | null;
  targetReadOnly: boolean;
  onCreate: (input: NativeAutomationInput) => Promise<NativeAutomation>;
  // The caller must handle an explicit target edit; it cannot silently discard it.
  onUpdate: (automationId: string, input: NativeAutomationInput, original: NativeAutomation) => Promise<NativeAutomation>;
  renderRuns: (automationId: string) => ReactNode;
};
type IntervalAutomationEditorProps = EditorCommonProps & {
  mode?: "interval";
  automation: Automation | null;
  onCreate: (request: AutomationCreateRequest) => Promise<Automation>;
  onUpdate: (automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
};
type AutomationEditorProps = IntervalAutomationEditorProps | CalendarAutomationEditorProps;

function editorValues(automation: Automation | NativeAutomation | null, fallbackThreadId: string | null): AutomationFormValues {
  if (!automation || "schedule" in automation) return automationFormValues(automation, fallbackThreadId);
  return { ...automationFormValues(null, fallbackThreadId), name: automation.name, prompt: automation.prompt, targetThreadId: automation.targetThreadId };
}

const REPEAT_UNIT_OPTIONS = [
  { label: "Seconds", value: "seconds" },
  { label: "Minutes", value: "minutes" },
  { label: "Hours", value: "hours" },
];

export function AutomationEditorModal(props: AutomationEditorProps) {
  const { automation, fallbackThreadId, onClose, onDelete, onPause, onResume, opened, threadOptions, renderRuns } = props;
  const [values, setValues] = useState<AutomationFormValues>(() => editorValues(automation, fallbackThreadId));
  const [calendarOriginal, setCalendarOriginal] = useState<NativeAutomation | null>(() => props.mode === "calendar" ? props.automation : null);
  const [calendar, setCalendar] = useState(() => nativeAutomationScheduleDraft(
    automation && "cron" in automation ? { cron: automation.cron, timezone: automation.timezone ?? "" } : null,
  ));
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [deletePendingConfirmation, setDeletePendingConfirmation] = useState(false);
  const [compactTab, setCompactTab] = useState<"details" | "prompt">("details");
  const [error, setError] = useState<string | null>(null);
  const title = automation ? "Automation details" : "New automation";
  const isSubmitting = submittingAction !== null;
  const compactDialog = useCompactDialog();
  const selectedThreadExists = values.targetThreadId
    ? threadOptions.some((option) => option.value === values.targetThreadId)
    : true;
  const targetThreadOptions = useMemo(() => {
    if (!values.targetThreadId || selectedThreadExists) {
      return threadOptions;
    }
    return [{ label: values.targetThreadId, value: values.targetThreadId }, ...threadOptions];
  }, [selectedThreadExists, threadOptions, values.targetThreadId]);

  const formIdentity = props.mode === "calendar" ? automation?.id : automation;
  const formFallback = props.mode === "calendar" ? undefined : fallbackThreadId;
  useEffect(() => {
    if (opened) {
      setValues(editorValues(automation, fallbackThreadId));
      setCalendarOriginal(props.mode === "calendar" ? props.automation : null);
      setCalendar(nativeAutomationScheduleDraft(automation && "cron" in automation ? { cron: automation.cron, timezone: automation.timezone ?? "" } : null));
      setError(null);
      setDeletePendingConfirmation(false);
      setSubmittingAction(null);
      setCompactTab("details");
    }
  }, [formIdentity, formFallback, opened]);

  async function handleSave() {
    const validationError = props.mode === "calendar"
      ? !values.name.trim() ? "Name is required." : !values.targetThreadId ? "Target thread is required."
        : !values.prompt.trim() ? "Prompt is required." : nativeAutomationScheduleError(calendar)
      : automationValidationError(values);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!values.targetThreadId) return;
    setSubmittingAction("save");
    setError(null);
    try {
      if (props.mode === "calendar") {
        const input: NativeAutomationInput = {
          name: values.name.trim(), prompt: values.prompt, targetThreadId: values.targetThreadId,
          cron: calendar.cron, timezone: calendar.timezone,
        };
        if (props.automation) {
          if (!calendarOriginal) return;
          await props.onUpdate(props.automation.id, input, calendarOriginal);
        }
        else await props.onCreate(input);
      } else {
        const startAt = startAtIsoFromLocalInput(values.startAtLocal);
        if (!startAt) return;
        const schedule = { startAt, repeatEvery: { value: values.repeatValue, unit: values.repeatUnit } };
        const input = { name: values.name.trim(), prompt: values.prompt.trim(), targetThreadId: values.targetThreadId, schedule };
        if (props.automation) await props.onUpdate(props.automation.id, input);
        else await props.onCreate(input);
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
        disabled={props.mode === "calendar" && props.targetReadOnly && Boolean(automation)}
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
      {props.mode === "calendar" ? <NativeAutomationScheduleFields value={calendar} onChange={setCalendar} /> : <>
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
      </>}
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
      centered={!compactDialog}
      className="kodex-automation-modal"
      fullScreen={compactDialog}
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
        {compactDialog ? (
          <Tabs
            className="kodex-automation-modal-tabs"
            keepMounted={false}
            onChange={(value) => {
              if (value === "details" || value === "prompt") {
                setCompactTab(value);
              }
            }}
            value={compactTab}
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
        {automation && opened ? renderRuns ? renderRuns(automation.id) : <AutomationRuns automationId={automation.id} /> : null}
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
                {automation.status !== "completed" ? <AdaptiveIconButton
                  className="kodex-automation-status-action"
                  disabled={isSubmitting}
                  label={automation.status === "paused" ? "Resume" : "Pause"}
                  loading={submittingAction === "pause" || submittingAction === "resume"}
                  onClick={() => void handleAction(automation.status === "paused" ? "resume" : "pause")}

                >
                  {automation.status === "paused" ? <Play /> : <Pause />}
                </AdaptiveIconButton> : null}
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
