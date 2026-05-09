import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelLogin,
  getAccount,
  logout,
  startLogin,
  type AccountResponse,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { LoginState } from "./SidebarAccountFooter";

type UseAccountSessionParams = {
  onError: (error: unknown) => void;
};

export function useAccountSession({ onError }: UseAccountSessionParams) {
  const queryClient = useQueryClient();
  const accountQuery = useQuery({
    queryKey: queryKeys.account,
    queryFn: getAccount,
  });
  const [loginState, setLoginState] = useState<LoginState>({});
  const loginMutation = useMutation({
    mutationFn: startLogin,
    onError,
    onSuccess: (login) => setLoginState({ authUrl: login.authUrl, loginId: login.loginId }),
  });
  const cancelLoginMutation = useMutation({
    mutationFn: cancelLogin,
    onError,
    onSuccess: () => setLoginState({}),
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onError,
    onSuccess: () => {
      queryClient.setQueryData<AccountResponse>(queryKeys.account, {
        requiresOpenaiAuth: true,
        account: null,
        rawPayload: {},
      });
    },
  });

  async function handleLogin() {
    loginMutation.mutate();
  }

  async function handleCancelLogin() {
    if (!loginState.loginId) {
      return;
    }
    cancelLoginMutation.mutate(loginState.loginId);
  }

  async function handleLogout() {
    logoutMutation.mutate();
  }

  return {
    account: accountQuery.data ?? null,
    handleCancelLogin,
    handleLogin,
    handleLogout,
    loginState,
  };
}
