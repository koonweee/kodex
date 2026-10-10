import type {
  ComposerSettingsResponse,
  CreateThreadOptions,
  EventEnvelope,
  ModelSummary,
  ThreadSettingsUpdateRequest,
  ThreadSettingsResponse,
} from "../api/client";
import type { ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import { asRecord, numberValue } from "../shared/values";
import { selectedModel, supportsReasoningEffort } from "./modelCatalog";

export type ComposerContext = {
  activeSelectedTurnId: string | null;
  draftChatThreadSelected: boolean;
  draftThreadProjectId: string | null;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
};

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = { fast: false };

export function sameComposerSettings(left: ComposerSettings, right: ComposerSettings): boolean {
  return (
    left.fast === right.fast &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.serviceTier === right.serviceTier
  );
}

export function normalizePersistedComposerSettings(
  settings: ComposerSettingsResponse,
  models: ModelSummary[],
): ComposerSettings {
  const effectiveModel = selectedModel(models, settings.model);
  const model = settings.model && effectiveModel ? settings.model : undefined;
  const effort =
    effectiveModel && settings.effort && supportsReasoningEffort(effectiveModel, settings.effort)
      ? settings.effort
      : undefined;

  return {
    model,
    effort,
    fast: settings.serviceTier === "fast",
    serviceTier: settings.serviceTier ?? undefined,
  };
}

export function composerSettingsFromNative(settings: ThreadSettingsResponse): ComposerSettings {
  return {
    model: settings.model,
    effort: settings.effort ?? undefined,
    fast: settings.serviceTier === "fast",
    serviceTier: settings.serviceTier,
  };
}

export function applyDraftComposerSettingsChange(current: ComposerSettings, change: ComposerSettingsChange, models: ModelSummary[]): ComposerSettings {
  const next = { ...current, ...change };
  if (change.model && current.effort && change.effort === undefined) {
    const model = models.find((candidate) => candidate.id === change.model);
    if (model && !supportsReasoningEffort(model, current.effort)) next.effort = undefined;
  }
  return next;
}

export function createThreadOptions(settings: ComposerSettings): CreateThreadOptions {
  const options: CreateThreadOptions = {};
  if (settings.model) {
    options.model = settings.model;
  }
  if (settings.effort) {
    options.effort = settings.effort;
  }
  if (settings.serviceTier !== undefined) {
    options.serviceTier = settings.serviceTier;
  } else if (settings.fast) {
    options.serviceTier = "fast";
  }
  return options;
}

export function composerThreadSettingsPatch(change: ComposerSettingsChange): ThreadSettingsUpdateRequest {
  const patch: ThreadSettingsUpdateRequest = {};
  if (change.model !== undefined) patch.model = change.model;
  if (change.effort !== undefined) patch.effort = change.effort;
  if (change.serviceTier !== undefined) patch.serviceTier = change.serviceTier;
  else if (change.fast !== undefined) patch.serviceTier = change.fast ? "fast" : null;
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
