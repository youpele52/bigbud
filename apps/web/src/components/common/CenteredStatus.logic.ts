const LOADING_STATUSES = new Set([
  "loading",
  "warming",
  "warming up",
  "connecting",
  "retrying",
  "pending",
  "refreshing",
  "building",
  "waiting",
]);

/** Exact states avoid treating an error mentioning loading as ongoing activity. */
export function isLoadingStatus(status: string): boolean {
  return LOADING_STATUSES.has(status.toLowerCase().replaceAll("_", " ").trim());
}
