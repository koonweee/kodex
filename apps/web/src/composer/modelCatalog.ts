import type { ModelSummary } from "../api/client";

export function defaultModel(models: ModelSummary[]): ModelSummary | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

export function selectedModel(models: ModelSummary[], modelId?: string | null): ModelSummary | null {
  return modelId ? models.find((model) => model.id === modelId) ?? null : defaultModel(models);
}

export function modelFullLabel(model: ModelSummary | null): string {
  return model?.model || model?.displayName || model?.id || "Model";
}

export function reasoningEffortLabel(value: string): string {
  if (value.toLowerCase() === "xhigh") {
    return "xHigh";
  }
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

export function supportsReasoningEffort(model: ModelSummary, effort: string): boolean {
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort);
}

export function compatibleEffort(model: ModelSummary | null, currentEffort?: string | null): string | null {
  if (!model) return null;
  if (currentEffort && supportsReasoningEffort(model, currentEffort)) return currentEffort;
  return supportsReasoningEffort(model, model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : null;
}
