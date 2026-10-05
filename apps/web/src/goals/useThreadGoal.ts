import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clearThreadGoal, getThreadGoal, updateThreadGoal, type ThreadGoalUpdateRequest } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";
import { refreshThreadGoals } from "./goalCache";

export function useThreadGoal(threadId: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.threadGoal(threadId),
    enabled: threadId !== null,
    retry: false,
    queryFn: ({ signal }) => getThreadGoal(threadId!, signal),
  });
  const mutationKey = ["change-thread-goal", threadId];
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (operation: { threadId: string | null } & ({ type: "update"; request: ThreadGoalUpdateRequest } | { type: "clear" })) => {
      if (!operation.threadId) throw new Error("Select a chat before setting a goal.");
      return operation.type === "clear" ? clearThreadGoal(operation.threadId) : updateThreadGoal(operation.threadId, operation.request);
    },
    onSettled: (_result, _error, operation) => operation.threadId ? refreshThreadGoals(client, operation.threadId) : undefined,
  });
  const pending = useIsMutating({ mutationKey }) > 0;
  const error = (mutation.variables?.threadId === threadId ? mutation.error : null) ?? query.error;
  return {
    goal: query.data?.goal ?? null,
    ready: threadId !== null && query.isSuccess,
    pending,
    error: error ? errorMessageFrom(error) : null,
    update: (request: ThreadGoalUpdateRequest) => mutation.mutateAsync({ threadId, type: "update", request }),
    clear: () => mutation.mutateAsync({ threadId, type: "clear" }),
    resetError: mutation.reset,
    reload: () => {
      mutation.reset();
      if (threadId) void refreshThreadGoals(client, threadId);
    },
  };
}
