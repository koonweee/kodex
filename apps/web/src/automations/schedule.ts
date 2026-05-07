import type { Automation } from "../api/client";

export type AutomationFormValues = {
  name: string;
  prompt: string;
  repeatUnit: Automation["schedule"]["repeatEvery"]["unit"];
  repeatValue: number;
  startAtLocal: string;
  targetThreadId: string | null;
};

export function automationFormValues(
  automation: Automation | null,
  fallbackThreadId: string | null,
): AutomationFormValues {
  return {
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    ...displayRepeatEvery(automation?.schedule.repeatEvery),
    startAtLocal: localDateTimeInputValue(automation?.schedule.startAt ?? new Date().toISOString()),
    targetThreadId: automation?.targetThreadId ?? fallbackThreadId,
  };
}

export function displayRepeatEvery(
  repeatEvery: Automation["schedule"]["repeatEvery"] | null | undefined,
): Pick<AutomationFormValues, "repeatUnit" | "repeatValue"> {
  if (!repeatEvery) {
    return { repeatUnit: "minutes", repeatValue: 30 };
  }
  if (repeatEvery.unit !== "seconds") {
    return { repeatUnit: repeatEvery.unit, repeatValue: repeatEvery.value };
  }
  if (repeatEvery.value >= 60 * 60 && repeatEvery.value % (60 * 60) === 0) {
    return { repeatUnit: "hours", repeatValue: repeatEvery.value / (60 * 60) };
  }
  if (repeatEvery.value >= 60 && repeatEvery.value % 60 === 0) {
    return { repeatUnit: "minutes", repeatValue: repeatEvery.value / 60 };
  }
  return { repeatUnit: "seconds", repeatValue: repeatEvery.value };
}

export function startAtIsoFromLocalInput(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function repeatEverySeconds(value: number, unit: AutomationFormValues["repeatUnit"]): number {
  const multiplier = unit === "hours" ? 60 * 60 : unit === "minutes" ? 60 : 1;
  return value * multiplier;
}

export function formatAutomationInterval(automation: Automation): string {
  if (!automation?.schedule?.repeatEvery) {
    return "";
  }
  const repeat = displayRepeatEvery(automation.schedule.repeatEvery);
  const unit = repeat.repeatValue === 1 ? repeat.repeatUnit.replace(/s$/, "") : repeat.repeatUnit;
  return `${repeat.repeatValue} ${unit}`;
}

export function formatAutomationDate(value: string | null | undefined): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function automationValidationError(values: AutomationFormValues): string | null {
  if (!values.name.trim()) {
    return "Name is required.";
  }
  if (!values.targetThreadId) {
    return "Target thread is required.";
  }
  if (!values.startAtLocal || !startAtIsoFromLocalInput(values.startAtLocal)) {
    return "Start time must be valid.";
  }
  if (!Number.isFinite(values.repeatValue) || values.repeatValue <= 0) {
    return "Repeat interval must be positive.";
  }
  if (repeatEverySeconds(values.repeatValue, values.repeatUnit) < 30) {
    return "Repeat interval must be at least 30 seconds.";
  }
  if (!values.prompt.trim()) {
    return "Prompt is required.";
  }
  return null;
}

function localDateTimeInputValue(isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
