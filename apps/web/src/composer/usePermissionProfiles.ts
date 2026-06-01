import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { listPermissionProfiles, type PermissionProfileSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";

type UsePermissionProfilesParams = {
  cwd?: string | null;
  enabled?: boolean;
};

export type PermissionProfileCatalog = {
  error: string | null;
  isLoading: boolean;
  profiles: PermissionProfileSummary[];
};

export function usePermissionProfiles({ cwd = null, enabled = true }: UsePermissionProfilesParams): PermissionProfileCatalog {
  const queryKey = useMemo(() => queryKeys.permissionProfiles(cwd ?? null), [cwd]);
  const profilesQuery = useQuery({
    enabled,
    queryKey,
    queryFn: () => listPermissionProfiles(cwd),
    staleTime: 30_000,
  });

  return {
    error: profilesQuery.error instanceof Error ? profilesQuery.error.message : profilesQuery.error ? "Unable to load permission profiles" : null,
    isLoading: profilesQuery.isLoading,
    profiles: profilesQuery.data ?? [],
  };
}
