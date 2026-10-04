import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAccount, logout } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { refreshAccountQueries } from "./cache";

type UseAccountSessionParams = {
  onError: (error: unknown) => void;
};

export function useAccountSession({ onError }: UseAccountSessionParams) {
  const queryClient = useQueryClient();
  const accountQuery = useQuery({
    queryKey: queryKeys.account,
    queryFn: ({ signal }) => getAccount(signal),
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onError,
    onSuccess: () => refreshAccountQueries(queryClient, { reset: true }),
  });

  return {
    account: accountQuery.data ?? null,
    handleLogout: () => logoutMutation.mutate(),
  };
}
