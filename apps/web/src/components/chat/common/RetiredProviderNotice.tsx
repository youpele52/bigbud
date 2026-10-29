import { getProviderReadOnlyMessage } from "@bigbud/shared/providerLifecycle";
import { TriangleAlertIcon } from "lucide-react";
import { ThreadNoticeBanner } from "./ThreadNoticeBanner";

export function RetiredProviderNotice({
  threadId = "retired-provider",
  provider,
}: {
  readonly threadId?: string;
  readonly provider?: string | null | undefined;
}) {
  const name = provider === "kilocode" ? "KiloCode" : "OpenCode";
  return (
    <ThreadNoticeBanner
      threadId={threadId}
      kind={provider === "kilocode" ? "removed-kilocode" : "legacy-opencode"}
      variant="warning"
      role="status"
      icon={<TriangleAlertIcon />}
      description={getProviderReadOnlyMessage(provider)}
      dismissLabel={`Dismiss legacy ${name} notice`}
    />
  );
}
