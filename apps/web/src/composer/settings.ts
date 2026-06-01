import type {
  ComposerSettingsResponse,
  ComposerSettingsUpdateRequest,
  CreateThreadOptions,
  EventEnvelope,
  ModelSummary,
  ThreadSettingsUpdateRequest,
  ThreadSummary,
  TurnStartOptions,
} from "../api/client";
import type { ComposerSettings, ContextUsage } from "../ComposerFooterControls";
import { asRecord, numberValue, stringValue } from "../shared/values";

export type ComposerContext = {
  activeSelectedTurnId: string | null;
  draftChatThreadSelected: boolean;
  draftThreadProjectId: string | null;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
};

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = { fast: false };

export function normalizePersistedComposerSettings(
  settings: ComposerSettingsResponse,
  models: ModelSummary[],
): ComposerSettings {
  const model = settings.model && models.some((candidate) => candidate.id === settings.model) ? settings.model : undefined;
  const selectedModel = model ? models.find((candidate) => candidate.id === model) : null;
  const effort =
    selectedModel && settings.effort && supportsReasoningEffort(selectedModel, settings.effort)
      ? settings.effort
      : undefined;

  return {
    model,
    effort,
    fast: settings.serviceTier === "fast",
    permissionProfileId: settings.permissionProfileId ?? undefined,
  };
}

export function mergeDurableComposerSettings(
  current: ComposerSettings,
  patch: ComposerSettingsUpdateRequest,
): ComposerSettings {
  return {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(patch, "model") ? { model: patch.model ?? undefined } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "effort") ? { effort: patch.effort ?? undefined } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "serviceTier") ? { fast: patch.serviceTier === "fast" } : {}),
  };
}

type ThreadComposerSettingsSource = Pick<
  ThreadSummary,
  "activePermissionProfile" | "model" | "reasoningEffort" | "serviceTier"
> & {
  rawPayload?: unknown;
};

export function composerSettingsFromThread(thread: ThreadComposerSettingsSource): ComposerSettings | null {
  const rawPayload = asRecord(thread.rawPayload);
  const model = stringValue(thread.model) ?? stringValue(rawPayload.model);
  const effort = stringValue(thread.reasoningEffort) ?? stringValue(rawPayload.reasoningEffort);
  const serviceTier = stringValue(thread.serviceTier) ?? stringValue(rawPayload.serviceTier);
  const activePermissionProfile =
    thread.activePermissionProfile === undefined
      ? asRecord(rawPayload.activePermissionProfile)
      : asRecord(thread.activePermissionProfile);
  const permissionProfileId = stringValue(activePermissionProfile.id);

  if (!model && !effort && !serviceTier && !permissionProfileId) {
    return null;
  }

  return {
    model: model ?? undefined,
    effort: effort ?? undefined,
    fast: serviceTier === "fast",
    permissionProfileId: permissionProfileId ?? undefined,
  };
}

export function createThreadOptions(settings: ComposerSettings): CreateThreadOptions {
  const options: CreateThreadOptions = {};
  if (settings.model) {
    options.model = settings.model;
  }
  if (settings.effort) {
    options.effort = settings.effort;
  }
  if (settings.fast) {
    options.serviceTier = "fast";
  }
  if (settings.permissionProfileId) {
    options.permissions = settings.permissionProfileId;
  }
  return options;
}

export function composerTurnOptions(settings: ComposerSettings): TurnStartOptions {
  const options: TurnStartOptions = {};
  if (settings.model) {
    options.model = settings.model;
  }
  if (settings.effort) {
    options.effort = settings.effort;
  }
  if (settings.fast) {
    options.serviceTier = "fast";
  }
  if (settings.permissionProfileId) {
    options.permissions = settings.permissionProfileId;
  }
  return options;
}

export function composerThreadSettingsPatch(
  previousSettings: ComposerSettings,
  nextSettings: ComposerSettings,
): ThreadSettingsUpdateRequest {
  const patch: ThreadSettingsUpdateRequest = {};
  if (previousSettings.model !== nextSettings.model) {
    patch.model = nextSettings.model ?? null;
  }
  if (previousSettings.effort !== nextSettings.effort) {
    patch.effort = nextSettings.effort ?? null;
  }
  if (previousSettings.fast !== nextSettings.fast) {
    patch.serviceTier = nextSettings.fast ? "fast" : null;
  }
  if (previousSettings.permissionProfileId !== nextSettings.permissionProfileId) {
    patch.permissions = nextSettings.permissionProfileId ?? null;
  }
  return patch;
}

export function contextUsageFromEvent(event: EventEnvelope): ContextUsage | null {
  if ((event.codexMethod ?? "").toLowerCase() !== "thread/tokenusage/updated") {
    return null;
  }

  const payload = asRecord(event.payload);
  const tokenUsage = asRecord(payload.tokenUsage ?? payload.token_usage ?? event.payload);
  const last = asRecord(tokenUsage.last);
  const total = asRecord(tokenUsage.total);
  const contextTokens =
    numberValue(last.totalTokens ?? last.total_tokens) ??
    numberValue(total.totalTokens ?? total.total_tokens ?? tokenUsage.totalTokens ?? tokenUsage.total_tokens);
  const modelContextWindow = numberValue(tokenUsage.modelContextWindow ?? tokenUsage.model_context_window);
  if (contextTokens === null && modelContextWindow === null) {
    return null;
  }
  return { contextTokens, modelContextWindow };
}

export function sameComposerContext(left: ComposerContext | null, right: ComposerContext): boolean {
  return (
    left?.activeSelectedTurnId === right.activeSelectedTurnId &&
    left.draftChatThreadSelected === right.draftChatThreadSelected &&
    left.draftThreadProjectId === right.draftThreadProjectId &&
    left.selectedProjectId === right.selectedProjectId &&
    left.selectedThreadId === right.selectedThreadId
  );
}

function supportsReasoningEffort(model: ModelSummary, effort: string) {
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort);
}
