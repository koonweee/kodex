import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useGatewayClient } from "../api/GatewayClientContext";
import { queryKeys } from "../api/queryKeys";
import { refreshAccountQueries } from "./cache";

type UseAccountSessionParams = {
  onError: (error: unknown) => void;
};

export function useAccountSession({ onError }: UseAccountSessionParams) {
  const api = useGatewayClient();
  const queryClient = useQueryClient();
  const accountQuery = useQuery({
    queryKey: queryKeys.account,
    queryFn: ({ signal }) => api.getAccount(signal),
  });
  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onError,
    onSuccess: () => refreshAccountQueries(queryClient, { reset: true }),
  });

  return {
    account: accountQuery.data ?? null,
    handleLogout: () => logoutMutation.mutate(),
  };
}
