import type {
  ProviderKind,
  RuntimeMode,
} from "@bigbud/contracts/orchestration/orchestration.provider";
import type { OpencodeV2DevelopmentSettings } from "@bigbud/contracts/core/settings.opencodeV2.ts";
import { InfoIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { StatusBanner } from "../../common/StatusBanner";

const ACCESS_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

export const ACCESS_MODE_INFO_DURATION_MS = 3000;

interface AccessModeInfoNotice {
  readonly threadId: string;
  readonly provider: ProviderKind;
  readonly runtimeMode: RuntimeMode;
  readonly accessModeChangeId: number;
  readonly connectionMode: OpencodeV2DevelopmentSettings["connectionMode"];
}

export function getAccessModeInfoDescription(
  runtimeMode: RuntimeMode,
  connectionMode: OpencodeV2DevelopmentSettings["connectionMode"] = "shared",
) {
  const shared = connectionMode === "shared";
  return runtimeMode === "approval-required"
    ? "Supervised asks before actions."
    : runtimeMode === "auto-accept-edits"
      ? shared
        ? "Auto-accept edits permits native file edits; other actions still ask."
        : "Auto-accept edits permits only bounded canonical file edits; other actions still ask. If the bounded file helper is unavailable, native edits still ask."
      : shared
        ? "Full access trusts native tools with host-user filesystem, process and network access—not a sandbox."
        : "In co-located workspaces, Full access trusts native tools with host-user filesystem, process and network access—not a sandbox.";
}

export const AccessModeInfoBanner = memo(function AccessModeInfoBanner({
  threadId,
  provider,
  runtimeMode,
  accessModeChangeId,
  connectionMode = "shared",
}: {
  threadId: string;
  provider: ProviderKind;
  runtimeMode: RuntimeMode;
  accessModeChangeId: number;
  connectionMode?: OpencodeV2DevelopmentSettings["connectionMode"];
}) {
  const [notice, setNotice] = useState<AccessModeInfoNotice | null>(null);
  const lastChangeId = useRef(accessModeChangeId);

  useEffect(() => {
    setNotice(null);
    if (lastChangeId.current === accessModeChangeId) return;
    lastChangeId.current = accessModeChangeId;
    if (provider !== "opencodeV2") return;

    setNotice({ threadId, provider, runtimeMode, accessModeChangeId, connectionMode });
    const timeout = window.setTimeout(() => setNotice(null), ACCESS_MODE_INFO_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [accessModeChangeId, connectionMode, provider, runtimeMode, threadId]);

  const isVisible =
    provider === "opencodeV2" &&
    notice?.threadId === threadId &&
    notice.provider === provider &&
    notice.runtimeMode === runtimeMode &&
    notice.accessModeChangeId === accessModeChangeId &&
    notice.connectionMode === connectionMode;
  if (!isVisible) return null;

  const shared = connectionMode === "shared";
  const description = getAccessModeInfoDescription(runtimeMode, connectionMode);

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
        onDismiss={() => setNotice(null)}
      />
    </div>
  );
});
