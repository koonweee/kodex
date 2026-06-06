import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  getComposerSettings,
  listModels,
  type ModelSummary,
  type ThreadSummary,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings } from "../ComposerFooterControls";
import {
  composerSettingsFromThread,
  DEFAULT_COMPOSER_SETTINGS,
  normalizePersistedComposerSettings,
  sameComposerSettings,
} from "./settings";

type UseComposerSettingsStateParams = {
  onError: (error: unknown) => void;
  draftChatThreadSelected: boolean;
  selectedProjectId: string | null;
  selectedThread: ThreadSummary | null;
};

export function useComposerSettingsState({
  onError,
  draftChatThreadSelected,
  selectedProjectId,
  selectedThread,
}: UseComposerSettingsStateParams) {
  const queryClient = useQueryClient();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [composerDefaults, setComposerDefaults] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [globalComposerDefaults, setGlobalComposerDefaults] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [selectedThreadComposerOverride, setSelectedThreadComposerOverride] = useState<ComposerSettings | null>(null);
  const draftComposerEditedRef = useRef(false);

  useEffect(() => {
    setSelectedThreadComposerOverride(null);
  }, [
    selectedThread?.id,
    selectedThread?.model,
    selectedThread?.reasoningEffort,
    selectedThread?.serviceTier,
  ]);

  const selectedThreadSettings = selectedThread ? composerSettingsFromThread(selectedThread) : null;
  const composerSettings = selectedThread
    ? selectedThreadComposerOverride ??
      selectedThreadSettings ??
      (selectedProjectId === null ? globalComposerDefaults : composerDefaults)
    : draftChatThreadSelected && !draftComposerEditedRef.current
      ? globalComposerDefaults
      : draftComposerSettings;

  const hydrateComposerDefaults = useCallback(async (projectId: string | null): Promise<ComposerSettings | null> => {
    try {
      const nextModels = await queryClient.fetchQuery({
        queryKey: queryKeys.models,
        queryFn: listModels,
      });
      setModels((current) => (sameModelSummaries(current, nextModels) ? current : nextModels));
      const settings = await queryClient.fetchQuery({
        queryKey: queryKeys.composerSettings(projectId),
        queryFn: () => getComposerSettings(projectId),
      });
      const normalized = normalizePersistedComposerSettings(settings, nextModels);
      setComposerDefaults((current) => (sameComposerSettings(current, normalized) ? current : normalized));
      if (projectId === null) {
        setGlobalComposerDefaults((current) => (sameComposerSettings(current, normalized) ? current : normalized));
      }
      if (!draftComposerEditedRef.current) {
        setDraftComposerSettings((current) => (sameComposerSettings(current, normalized) ? current : normalized));
      }
      return normalized;
    } catch (error) {
      if (models.length === 0) {
        try {
          const nextModels = await queryClient.fetchQuery({ queryKey: queryKeys.models, queryFn: listModels });
          setModels((current) => (sameModelSummaries(current, nextModels) ? current : nextModels));
        } catch (modelsError) {
          onError(modelsError);
        }
      }
      return null;
    }
  }, [models.length, onError, queryClient]);

  function handleComposerSettingsChange(nextSettings: ComposerSettings) {
    if (selectedThread) {
      setSelectedThreadComposerOverride(nextSettings);
      return;
    }

    draftComposerEditedRef.current = true;
    setDraftComposerSettings(nextSettings);
  }

  return {
    composerSettings,
    composerSettingsError: null,
    draftComposerEditedRef,
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
    workspaceComposerDefaults: globalComposerDefaults,
  };
}

function sameModelSummaries(left: ModelSummary[], right: ModelSummary[]): boolean {
  if (left === right) {
    return true;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
