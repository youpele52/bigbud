import { useBannerDismissal, type BannerIdentity } from "./useBannerDismissal";

// Compatibility for existing notice consumers/tests; all banners now share the app-run policy.
export { useBannerDismissalStore as useThreadNoticeDismissalStore } from "./bannerDismissal.store";

/** Explicit independent scope (e.g. plan ID), not copy, status, revision or token count. */
export function useThreadNoticeDismissal(
  threadId: string,
  kind: string,
  scope: BannerIdentity = [],
) {
  return useBannerDismissal(["thread", threadId, kind, ...scope]);
}
