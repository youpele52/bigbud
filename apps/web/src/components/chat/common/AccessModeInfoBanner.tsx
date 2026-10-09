import type {
  ProviderKind,
  RuntimeMode,
} from "@bigbud/contracts/orchestration/orchestration.provider";
import type { OpencodeV2DevelopmentSettings } from "@bigbud/contracts/core/settings.opencodeV2.ts";
import { InfoIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { StatusBanner } from "../../common/StatusBanner";

const ACCESS_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

export const AccessModeInfoBanner = memo(function AccessModeInfoBanner({
  threadId,
  provider,
  runtimeMode,
  connectionMode = "shared",
}: {
  threadId: string;
  provider: ProviderKind;
  runtimeMode: RuntimeMode;
  connectionMode?: OpencodeV2DevelopmentSettings["connectionMode"];
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
  }, [threadId, provider, runtimeMode, connectionMode]);

  if (provider !== "opencodeV2" || dismissed) return null;

  const shared = connectionMode === "shared";
  const description =
    runtimeMode === "approval-required"
      ? "Supervised asks before actions."
      : runtimeMode === "auto-accept-edits"
        ? shared
          ? "Auto-accept edits permits native file edits; other actions still ask."
          : "Auto-accept edits permits only bounded canonical file edits; other actions still ask. If the bounded file helper is unavailable, native edits still ask."
        : shared
          ? "Full access trusts native tools with host-user filesystem, process and network access—not a sandbox."
          : "In co-located workspaces, Full access trusts native tools with host-user filesystem, process and network access—not a sandbox.";

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant="default"
        role="status"
        icon={<InfoIcon />}
        title={`Access: ${ACCESS_LABELS[runtimeMode]}`}
        description={
          <span className="text-foreground">
            {description} External-directory requests still ask.
            {!shared
              ? " Synthetic remote workspaces never gain native file or shell access."
              : null}
          </span>
        }
        dismissLabel="Dismiss access information"
        onDismiss={() => setDismissed(true)}
      />
    </div>
  );
});
