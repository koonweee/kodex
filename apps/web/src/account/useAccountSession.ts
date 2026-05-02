import { useState } from "react";

import {
  cancelLogin,
  logout,
  startLogin,
  type AccountResponse,
} from "../api/client";
import type { LoginState } from "./SidebarAccountFooter";

type UseAccountSessionParams = {
  onError: (error: unknown) => void;
};

export function useAccountSession({ onError }: UseAccountSessionParams) {
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [loginState, setLoginState] = useState<LoginState>({});

  async function handleLogin() {
    try {
      const login = await startLogin();
      setLoginState({ authUrl: login.authUrl, loginId: login.loginId });
    } catch (error) {
      onError(error);
    }
  }

  async function handleCancelLogin() {
    if (!loginState.loginId) {
      return;
    }
    try {
      await cancelLogin(loginState.loginId);
      setLoginState({});
    } catch (error) {
      onError(error);
    }
  }

  async function handleLogout() {
    try {
      await logout();
      setAccount({ requiresOpenaiAuth: true, account: null, rawPayload: {} });
    } catch (error) {
      onError(error);
    }
  }

  return {
    account,
    handleCancelLogin,
    handleLogin,
    handleLogout,
    loginState,
    setAccount,
  };
}
