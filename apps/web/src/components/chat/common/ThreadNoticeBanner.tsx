import type { BannerIdentity } from "../../../stores/ui/useBannerDismissal";
import type { StatusBannerProps } from "../../common/StatusBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { ChatBanner } from "./ChatBanner";

/** Dismiss only this presentation, for this thread and semantic scope, until the app run ends. */
export function ThreadNoticeBanner({
  threadId,
  kind,
  scope,
  ...props
}: Omit<StatusBannerProps, "onDismiss" | "dismissalKey"> & {
  readonly threadId: string;
  readonly kind: string;
  readonly scope?: BannerIdentity;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, kind, scope);
  return dismissed ? null : <ChatBanner {...props} onDismiss={dismiss} />;
}
