import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { cancelLogin, startLogin, type AccountLoginCompleted, type AccountResponse, type LoginStartResponse } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { refreshAccountQueries } from "./cache";

export function useDeviceCodeLogin(account: AccountResponse | null) {
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [login, setLogin] = useState<LoginStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completion = useQuery<AccountLoginCompleted>({
    queryKey: queryKeys.accountLoginCompletion(login?.loginId ?? null),
    queryFn: skipToken,
  });
  const start = useMutation({
    mutationFn: startLogin,
    onMutate: () => {
      setOpened(true);
      setError(null);
      setLogin(null);
    },
    onSuccess: setLogin,
    onError: (cause) => setError(cause.message),
  });
  const cancel = useMutation({
    mutationFn: cancelLogin,
    onSuccess: () => {
      setOpened(false);
      setLogin(null);
      void refreshAccountQueries(queryClient);
    },
    onError: (cause) => setError(cause.message),
  });

  // account/read recovers successful sign-in across missed events. It cannot
  // recover a missed failure before an SSE cursor exists; Cancel permits retry.
  useEffect(() => {
    if (account?.account) {
      setOpened(false);
      setLogin(null);
    }
  }, [account, login]);

  useEffect(() => {
    if (!login || !completion.data) {
      return;
    }
    setLogin(null);
    if (completion.data.success) {
      setOpened(false);
    } else {
      setError(completion.data.error ?? "Sign-in was not completed. Try again.");
    }
  }, [completion.data, login]);

  const busy = start.isPending || cancel.isPending;
  function close() {
    if (busy) {
      return;
    }
    if (login) {
      cancel.mutate(login.loginId);
    } else {
      setOpened(false);
    }
  }

  return { opened, login, error, busy, start: () => start.mutate(), close };
}
