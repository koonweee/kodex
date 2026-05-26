import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  getComposerSettings,
  listModels,
  persistComposerSettings,
  type ModelSummary,
  type ThreadSummary,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import {
  composerSettingsFromThread,
  DEFAULT_COMPOSER_SETTINGS,
  mergeDurableComposerSettings,
  normalizePersistedComposerSettings,
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
  const [composerSettingsError, setComposerSettingsError] = useState<string | null>(null);
  const draftComposerEditedRef = useRef(false);
  const persistSettingsMutation = useMutation({
    mutationFn: persistComposerSettings,
    onError: (error) => {
      setComposerSettingsError(`Composer settings were not saved: ${errorMessageFrom(error)}`);
    },
    onSuccess: (_response, patch) => {
      setComposerDefaults((current) => mergeDurableComposerSettings(current, patch));
      queryClient.setQueriesData({ queryKey: queryKeys.composerSettingsRoot }, (current) =>
        current && typeof current === "object" ? { ...current, ...patch } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.composerSettingsRoot, refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.models, refetchType: "all" });
    },
  });

  useEffect(() => {
    setSelectedThreadComposerOverride(null);
  }, [
    selectedThread?.id,
    selectedThread?.model,
    selectedThread?.reasoningEffort,
    selectedThread?.serviceTier,
    selectedThread?.approvalPolicy,
    selectedThread?.approvalsReviewer,
    selectedThread?.sandbox,
  ]);

  const selectedThreadSettings = selectedThread ? composerSettingsFromThread(selectedThread) : null;
  const composerSettings = selectedThread
    ? selectedThreadComposerOverride ??
      selectedThreadSettings ??
      (selectedProjectId === null ? globalComposerDefaults : composerDefaults)
    : draftChatThreadSelected && !draftComposerEditedRef.current
      ? globalComposerDefaults
      : draftComposerSettings;

  async function hydrateComposerDefaults(projectId: string | null): Promise<ComposerSettings | null> {
    try {
      const nextModels = await queryClient.fetchQuery({
        queryKey: queryKeys.models,
        queryFn: listModels,
      });
      setModels(nextModels);
      const settings = await queryClient.fetchQuery({
        queryKey: queryKeys.composerSettings(projectId),
        queryFn: () => getComposerSettings(projectId),
      });
      const normalized = normalizePersistedComposerSettings(settings, nextModels);
      setComposerDefaults(normalized);
      if (projectId === null) {
        setGlobalComposerDefaults(normalized);
      }
      if (!draftComposerEditedRef.current) {
        setDraftComposerSettings(normalized);
      }
      return normalized;
    } catch (error) {
      if (models.length === 0) {
        try {
          setModels(await queryClient.fetchQuery({ queryKey: queryKeys.models, queryFn: listModels }));
        } catch (modelsError) {
          onError(modelsError);
        }
      }
      return null;
    }
  }

  function handleComposerSettingsChange(nextSettings: ComposerSettings) {
    const previousSettings = composerSettings;
    if (selectedThread) {
      setSelectedThreadComposerOverride(nextSettings);
    } else {
      draftComposerEditedRef.current = true;
      setDraftComposerSettings(nextSettings);
    }
    persistDurableComposerSettings(previousSettings, nextSettings);
  }

  function persistDurableComposerSettings(previousSettings: ComposerSettings, nextSettings: ComposerSettings) {
    const patch: Parameters<typeof persistComposerSettings>[0] = {};
    if (previousSettings.model !== nextSettings.model) {
      patch.model = nextSettings.model ?? null;
    }
    if (previousSettings.effort !== nextSettings.effort) {
      patch.effort = nextSettings.effort ?? null;
    }
    if (previousSettings.fast !== nextSettings.fast) {
      patch.serviceTier = nextSettings.fast ? "fast" : null;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    setComposerSettingsError(null);
    persistSettingsMutation.mutate(patch);
  }

  return {
    composerSettings,
    composerSettingsError,
    draftComposerEditedRef,
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
    selectedThreadComposerOverride,
  };
}
