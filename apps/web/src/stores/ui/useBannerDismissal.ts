import { useBannerDismissalStore } from "./bannerDismissal.store";

/** Semantic parts only: kind and independent scope IDs, never poll times or rendered copy. */
export type BannerIdentity = readonly (string | number | null | undefined)[];

/** The lifecycle welcome handler binds this store once, independently of mounted banners. */
export function useBannerDismissal(identity: BannerIdentity | undefined) {
  const key = identity ? JSON.stringify(identity) : null;
  const dismissed = useBannerDismissalStore((state) => key !== null && state.dismissed.has(key));
  const dismiss = useBannerDismissalStore((state) => state.dismiss);
  return {
    dismissed,
    dismiss: () => {
      if (key !== null) dismiss(key);
    },
  };
}
