import { useCallback, useEffect, useRef, useState } from "react";

import { listSkills, type SkillMetadata } from "../api/client";
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
  const [state, setState] = useState<SkillCatalogState>({
    error: null,
    loading: false,
    skills: [],
  });
  const requestIdRef = useRef(0);

  const refresh = useCallback(
    async (forceReload = false) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await listSkills(cwd ?? null, forceReload);
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({
          error: response.errors.length > 0 ? response.errors[0]?.message ?? "Some skills could not be loaded" : null,
          loading: false,
          skills: response.skills,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState((current) => ({
          ...current,
          error: errorMessageFrom(error),
          loading: false,
        }));
      }
    },
    [cwd],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh(false);
  }, [cwd, enabled, refresh]);

  useEffect(() => {
    if (!enabled || invalidationGeneration === 0) {
      return;
    }
    void refresh(true);
  }, [enabled, invalidationGeneration, refresh]);

  return { ...state, refresh };
}
