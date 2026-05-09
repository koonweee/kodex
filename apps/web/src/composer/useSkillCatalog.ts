import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { listSkills, type SkillMetadata } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";

export type SkillCatalogState = {
  error: string | null;
  loading: boolean;
  skills: SkillMetadata[];
};

export function useSkillCatalog({
  cwd,
  enabled,
  invalidationGeneration,
}: {
  cwd?: string | null;
  enabled: boolean;
  invalidationGeneration: number;
}) {
  const queryClient = useQueryClient();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const queryKey = useMemo(() => queryKeys.skills(cwd ?? null), [cwd]);
  const skillsQuery = useQuery({
    enabled,
    queryKey,
    queryFn: () => listSkills(cwd ?? null, false),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setRefreshError(null);
  }, [queryKey]);

  const refresh = useCallback(
    async (forceReload = false) => {
      try {
        const response = await listSkills(cwd ?? null, forceReload);
        queryClient.setQueryData(queryKey, response);
        setRefreshError(null);
      } catch (error) {
        setRefreshError(errorMessageFrom(error));
        // Query keeps the previous successful data while exposing the error state.
      }
    },
    [cwd, queryClient, queryKey],
  );

  useEffect(() => {
    if (!enabled || invalidationGeneration === 0) {
      return;
    }
    void refresh(true);
  }, [enabled, invalidationGeneration, refresh]);

  const response = skillsQuery.data;
  const responseError = response?.errors[0]?.message ?? null;
  const queryError = skillsQuery.error ? errorMessageFrom(skillsQuery.error) : null;
  return {
    error: refreshError ?? queryError ?? responseError,
    loading: skillsQuery.isLoading || skillsQuery.isFetching,
    refresh,
    skills: response?.skills ?? [],
  };
}
