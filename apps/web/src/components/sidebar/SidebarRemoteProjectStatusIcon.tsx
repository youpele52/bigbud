import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import type { AppCheckStatus } from "../../lib/checkStatus";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";

type RemoteProjectConnectionState = "connected" | "connecting" | "disconnected";

export function resolveRemoteProjectConnectionState(input: {
  checkStatus: AppCheckStatus | undefined;
  isVerified: boolean;
}): RemoteProjectConnectionState {
  if (input.checkStatus === "checking") {
    return "connecting";
  }
  if (input.isVerified || input.checkStatus === "verified") {
    return "connected";
  }
  return "disconnected";
}

const STATUS_STYLES: Record<
  RemoteProjectConnectionState,
  { indicatorClass: string; label: string }
> = {
  connected: { indicatorClass: "text-emerald-500", label: "Connected" },
  connecting: { indicatorClass: "text-amber-500", label: "Connecting" },
  disconnected: { indicatorClass: "text-red-500", label: "Disconnected" },
};

export function SidebarRemoteProjectStatusIcon({
  executionTargetId,
  remoteTargetLabel,
}: {
  executionTargetId: string;
  remoteTargetLabel: string | null;
}) {
  const checkStatus = useRemoteAccessStore(
    (store) => store.executionTargetChecks[executionTargetId]?.status,
  );
  const isVerified = useRemoteAccessStore(
    (store) => store.verifiedExecutionTargetIds[executionTargetId] === true,
  );
  const state = resolveRemoteProjectConnectionState({ checkStatus, isVerified });
  const status = STATUS_STYLES[state];
  const label = `${remoteTargetLabel ?? executionTargetId}: ${status.label}`;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-connection-state={state}
      className="inline-flex shrink-0 text-muted-foreground/80"
    >
      <svg
        aria-hidden="true"
        className={SIDEBAR_ICON_SIZE_CLASS}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
        <circle
          className={status.indicatorClass}
          cx="6"
          cy="6"
          r="1.35"
          fill="currentColor"
          stroke="none"
        />
        <circle
          className={status.indicatorClass}
          cx="6"
          cy="18"
          r="1.35"
          fill="currentColor"
          stroke="none"
        />
      </svg>
    </span>
  );
}
