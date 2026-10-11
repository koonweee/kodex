import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ModelSummary, Project } from "../api/client";
import { useGatewayClient } from "../api/GatewayClientContext";
import { queryKeys } from "../api/queryKeys";
import { singleProjectRoot } from "../projects/roots";
import type { ComposerSettings } from "../ComposerFooterControls";
import {
  DEFAULT_COMPOSER_SETTINGS,
  normalizePersistedComposerSettings,
  sameComposerSettings,
} from "./settings";

type UseComposerSettingsStateParams = {
  onError: (error: unknown) => void;
  projects: Project[];
};

export function useComposerSettingsState({
  onError,
  projects,
}: UseComposerSettingsStateParams) {
  const api = useGatewayClient();
  const queryClient = useQueryClient();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [composerDefaults, setComposerDefaults] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);

  const hydrateComposerDefaults = useCallback(async (projectId: string | null, cwd?: string | null): Promise<ComposerSettings | null> => {
    try {
      const nextModels = await queryClient.fetchQuery({
        queryKey: queryKeys.models,
        queryFn: api.listModels,
      });
      setModels((current) => (sameModelSummaries(current, nextModels) ? current : nextModels));
      const executionCwd = projectId !== null
        ? singleProjectRoot(projects.find((project) => project.id === projectId))
        : cwd ?? null;
      if (projectId !== null && !executionCwd) return null;
      const settings = await queryClient.fetchQuery({
        queryKey: queryKeys.composerSettings(projectId, executionCwd),
        queryFn: ({ signal }) => api.getComposerSettings(projectId, executionCwd, signal),
      });
      const normalized = normalizePersistedComposerSettings(settings, nextModels);
      if (projectId === null && !executionCwd) {
        setComposerDefaults((current) => (sameComposerSettings(current, normalized) ? current : normalized));
      }
      return normalized;
    } catch (error) {
      if (models.length === 0) {
        try {
          const nextModels = await queryClient.fetchQuery({ queryKey: queryKeys.models, queryFn: api.listModels });
          setModels((current) => (sameModelSummaries(current, nextModels) ? current : nextModels));
        } catch (modelsError) {
          onError(modelsError);
        }
      }
      return null;
    }
  }, [api, models.length, onError, projects, queryClient]);

  return {
    composerDefaults,
    hydrateComposerDefaults,
    models,
  };
}

function sameModelSummaries(left: ModelSummary[], right: ModelSummary[]): boolean {
  if (left === right) {
    return true;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
