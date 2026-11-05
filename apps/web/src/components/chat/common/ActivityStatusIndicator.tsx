import { Wifi } from "lucide-react";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { resolveActivityStatus } from "./ActivityStatusIndicator.logic";
import { formatWorkingTimer } from "../messages/MessagesTimeline.assistantMessage.meta";

import { AgentWorkingBlob } from "../../ui/agent-working-blob";
import { SpinnerVerbShimmer } from "./SpinnerVerbShimmer";
import { CHAT_COLUMN_CLASS_NAME } from "./chatColumn";

interface ActivityStatusIndicatorProps {
  verb: string;
  isCompacting: boolean;
  activeWorkStartedAt: string | null;
  nowIso: string;
}

export function ActivityStatusIndicator({
  verb,
  isCompacting,
  activeWorkStartedAt,
  nowIso,
}: ActivityStatusIndicatorProps) {
  const connection = useWsConnectionStatus();
  const status = resolveActivityStatus({ connection, isCompacting, verb });
  return (
    <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center px-5">
      <div className={`${CHAT_COLUMN_CLASS_NAME} px-1 py-0.5`}>
        <div
          className="flex items-center gap-2 rounded-md bg-transparent px-7 pt-1 pb-1 text-[11px] text-muted-foreground/70"
          role="status"
        >
          {status.kind === "working" ? <AgentWorkingBlob /> : null}
          <span className="inline-flex items-baseline leading-none">
            <SpinnerVerbShimmer
              verb={status.label}
              warningColor={status.kind !== "working"}
              leading={
                status.kind === "reconnecting" ? (
                  <Wifi
                    aria-hidden="true"
                    className="mr-2 inline-block size-3.5 shrink-0 align-[-0.15em]"
                  />
                ) : undefined
              }
            />
            <span aria-hidden="true" className="agent-working-ellipsis" />
          </span>
          <span className="flex-1" />
          {activeWorkStartedAt ? (
            <span className="leading-none">
              {formatWorkingTimer(activeWorkStartedAt, nowIso) ?? "0s"}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
