import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  getComposerSettings,
  listModels,
  type ModelSummary,
  type ThreadSummary,
  type Project,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { singleProjectRoot } from "../projects/roots";
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
  projects: Project[];
};

export function useComposerSettingsState({
  onError,
  draftChatThreadSelected,
  selectedProjectId,
  selectedThread,
  projects,
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

  const hydrateComposerDefaults = useCallback(async (projectId: string | null, cwd?: string | null): Promise<ComposerSettings | null> => {
    try {
      const nextModels = await queryClient.fetchQuery({
        queryKey: queryKeys.models,
        queryFn: listModels,
      });
      setModels((current) => (sameModelSummaries(current, nextModels) ? current : nextModels));
      const executionCwd = cwd === undefined
        ? singleProjectRoot(projects.find((project) => project.id === projectId))
        : cwd;
      if (projectId !== null && !executionCwd) return null;
      const settings = await queryClient.fetchQuery({
        queryKey: queryKeys.composerSettings(projectId, executionCwd),
        queryFn: ({ signal }) => getComposerSettings(projectId, executionCwd, signal),
      });
      const normalized = normalizePersistedComposerSettings(settings, nextModels);
      if (projectId === null && !executionCwd) {
        setComposerDefaults((current) => (sameComposerSettings(current, normalized) ? current : normalized));
        setGlobalComposerDefaults((current) => (sameComposerSettings(current, normalized) ? current : normalized));
        if (!draftComposerEditedRef.current) {
          setDraftComposerSettings((current) => (sameComposerSettings(current, normalized) ? current : normalized));
        }
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
  }, [models.length, onError, projects, queryClient]);

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
