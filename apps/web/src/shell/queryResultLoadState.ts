export function queryResultLoadState(query: {
  data?: unknown;
  isError?: boolean;
  isFetching?: boolean;
  isLoading?: boolean;
} | undefined): "error" | "loaded" | "loading" | "refetching" {
  if (!query || (query.data === undefined && (query.isLoading || query.isFetching))) {
    return "loading";
  }
  if (query.isError) {
    return "error";
  }
  if (query.isFetching) {
    return "refetching";
  }
  return "loaded";
}
