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
import type { ComposerSettings, ContextUsage, PermissionPresetId } from "../ComposerFooterControls";
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
    permissionPreset: permissionPresetFromGateway(settings.permissionsPreset),
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
  "approvalPolicy" | "approvalsReviewer" | "model" | "reasoningEffort" | "sandbox" | "serviceTier"
> & {
  rawPayload?: unknown;
};

export function composerSettingsFromThread(thread: ThreadComposerSettingsSource): ComposerSettings | null {
  const rawPayload = asRecord(thread.rawPayload);
  const model = stringValue(thread.model) ?? stringValue(rawPayload.model);
  const effort = stringValue(thread.reasoningEffort) ?? stringValue(rawPayload.reasoningEffort);
  const serviceTier = stringValue(thread.serviceTier) ?? stringValue(rawPayload.serviceTier);
  const approvalPolicy = stringValue(thread.approvalPolicy) ?? stringValue(rawPayload.approvalPolicy);
  const approvalsReviewer = stringValue(thread.approvalsReviewer) ?? stringValue(rawPayload.approvalsReviewer);
  const sandbox = thread.sandbox ?? rawPayload.sandbox;
  const permissionPreset = permissionPresetFromThread(approvalPolicy, approvalsReviewer, sandbox);

  if (!model && !effort && !serviceTier && !permissionPreset) {
    return null;
  }

  return {
    model: model ?? undefined,
    effort: effort ?? undefined,
    fast: serviceTier === "fast",
    permissionPreset,
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
  const permissions = permissionSettings(settings.permissionPreset);
  if (permissions) {
    options.approvalPolicy = permissions.approvalPolicy;
    options.approvalsReviewer = permissions.approvalsReviewer;
    options.sandbox = permissions.threadSandbox;
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
  const permissions = permissionSettings(settings.permissionPreset);
  if (permissions) {
    options.approvalPolicy = permissions.approvalPolicy;
    options.approvalsReviewer = permissions.approvalsReviewer;
    options.sandboxPolicy = permissions.turnSandboxPolicy;
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
  if (previousSettings.permissionPreset !== nextSettings.permissionPreset) {
    const permissions = permissionSettings(nextSettings.permissionPreset);
    if (permissions) {
      patch.approvalPolicy = permissions.approvalPolicy;
      patch.approvalsReviewer = permissions.approvalsReviewer;
      patch.sandboxPolicy = permissions.turnSandboxPolicy;
    } else {
      patch.approvalPolicy = null;
      patch.approvalsReviewer = null;
      patch.sandboxPolicy = null;
    }
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

function permissionPresetFromGateway(
  preset: ComposerSettingsResponse["permissionsPreset"] | undefined | null,
): PermissionPresetId | undefined {
  if (preset === "autoReview") {
    return "autoReview";
  }
  if (preset === "fullAccess") {
    return "fullAccess";
  }
  if (preset === "default") {
    return "default";
  }
  return undefined;
}

function permissionPresetFromThread(
  approvalPolicy: string | null,
  approvalsReviewer: string | null,
  sandbox: unknown,
): PermissionPresetId | undefined {
  const sandboxKind = sandboxPolicyKind(sandbox);
  if (approvalPolicy === "never" || sandboxKind === "danger-full-access" || sandboxKind === "dangerFullAccess") {
    return "fullAccess";
  }
  if (approvalsReviewer === "auto_review" || approvalsReviewer === "guardian_subagent") {
    return "autoReview";
  }
  if (approvalPolicy || approvalsReviewer || sandboxKind || sandbox != null) {
    return "default";
  }
  return undefined;
}

function sandboxPolicyKind(sandbox: unknown): string | null {
  const legacyMode = stringValue(sandbox);
  if (legacyMode) {
    return legacyMode;
  }

  return stringValue(asRecord(sandbox).type);
}

function permissionSettings(preset: PermissionPresetId | undefined) {
  if (!preset) {
    return null;
  }

  if (preset === "fullAccess") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: { type: "dangerFullAccess" },
    };
  }

  return {
    approvalPolicy: "on-request",
    approvalsReviewer: preset === "autoReview" ? "auto_review" : "user",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
  };
}
