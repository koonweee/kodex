import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getThreadSettings, updateThreadSettings } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettingsChange } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import { composerThreadSettingsPatch, composerSettingsFromNative } from "./settings";
import { refreshThreadSettings } from "./threadSettingsCache";

export function useThreadSettings(threadId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.threadSettings(threadId),
    enabled: threadId !== null,
    retry: false,
    queryFn: ({ signal }) => getThreadSettings(threadId!, signal),
  });
  const mutationKey = ["update-thread-settings", threadId];
  const mutation = useMutation({
    mutationKey,
    mutationFn: (change: ComposerSettingsChange) => updateThreadSettings(threadId!, composerThreadSettingsPatch(change)),
    // Native acknowledgment queues the change; only the read confirms applied settings.
    onSettled: () => {
      if (threadId) void refreshThreadSettings(queryClient, threadId);
    },
  });
  const pending = useIsMutating({ mutationKey }) > 0;
  const error = mutation.error ?? query.error;
  return {
    settings: query.data ? composerSettingsFromNative(query.data) : null,
    error: error ? errorMessageFrom(error) : null,
    pending,
    update: (change: ComposerSettingsChange) => {
      if (threadId && query.data && !pending) mutation.mutate(change);
    },
    reload: () => {
      mutation.reset();
      if (threadId) void refreshThreadSettings(queryClient, threadId);
    },
  };
}
