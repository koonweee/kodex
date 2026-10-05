import type { QueryClient } from "@tanstack/react-query";

export async function refreshNotificationQueries(queryClient: QueryClient) {
  const queryKey = ["notifications"];
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
}
