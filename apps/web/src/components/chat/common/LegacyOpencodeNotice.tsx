import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { TriangleAlertIcon } from "lucide-react";
import { ThreadNoticeBanner } from "./ThreadNoticeBanner";

/** Show read-only guidance in the chat's top warning banner area. */
export function LegacyOpencodeNotice({
  threadId = "legacy-opencode",
}: {
  readonly threadId?: string;
}) {
  return (
    <ThreadNoticeBanner
      threadId={threadId}
      kind="legacy-opencode"
      variant="warning"
      role="status"
      icon={<TriangleAlertIcon />}
      description={LEGACY_OPENCODE_READ_ONLY_MESSAGE}
      dismissLabel="Dismiss legacy OpenCode notice"
    />
  );
}
