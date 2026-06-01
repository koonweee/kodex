import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  getComposerSettings,
  listModels,
  persistComposerSettings,
  updateThreadSettings,
  type ModelSummary,
  type ThreadSummary,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import {
  composerSettingsFromThread,
  composerThreadSettingsPatch,
  DEFAULT_COMPOSER_SETTINGS,
  mergeDurableComposerSettings,
  normalizePersistedComposerSettings,
} from "./settings";

type UseComposerSettingsStateParams = {
  onError: (error: unknown) => void;
  onThreadUpdated: (thread: ThreadSummary) => void;
  draftChatThreadSelected: boolean;
  selectedProjectId: string | null;
  selectedThread: ThreadSummary | null;
};

export function useComposerSettingsState({
  onError,
  onThreadUpdated,
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
  const updateThreadSettingsMutation = useMutation({
    mutationFn: ({ patch, threadId }: { patch: ReturnType<typeof composerThreadSettingsPatch>; threadId: string }) =>
      updateThreadSettings(threadId, patch),
    onError: (error) => {
      setComposerSettingsError(`Thread settings were not saved: ${errorMessageFrom(error)}`);
    },
    onSuccess: (response) => {
      onThreadUpdated(response.thread);
    },
  });
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
    selectedThread?.activePermissionProfile?.id,
    selectedThread?.activePermissionProfile?.extends,
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
      persistSelectedThreadSettings(selectedThread, previousSettings, nextSettings);
      return;
    } else {
      draftComposerEditedRef.current = true;
      setDraftComposerSettings(nextSettings);
    }
    persistDurableComposerSettings(previousSettings, nextSettings);
  }

  function persistSelectedThreadSettings(
    thread: ThreadSummary,
    previousSettings: ComposerSettings,
    nextSettings: ComposerSettings,
  ) {
    const patch = composerThreadSettingsPatch(previousSettings, nextSettings);
    if (Object.keys(patch).length === 0) {
      return;
    }

    setComposerSettingsError(null);
    updateThreadSettingsMutation.mutate({ threadId: thread.id, patch });
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
