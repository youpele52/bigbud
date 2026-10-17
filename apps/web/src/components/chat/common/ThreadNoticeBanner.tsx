import type { StatusBannerProps } from "../../common/StatusBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { ChatBanner } from "./ChatBanner";

/** Dismiss only this presentation, for this thread and condition, until the renderer reloads. */
export function ThreadNoticeBanner({
  threadId,
  kind,
  condition,
  ...props
}: Omit<StatusBannerProps, "onDismiss"> & {
  readonly threadId: string;
  readonly kind: string;
  readonly condition: unknown;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, kind, condition);
  return dismissed ? null : <ChatBanner {...props} onDismiss={dismiss} />;
}
