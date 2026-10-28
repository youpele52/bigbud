import { ChevronRightIcon } from "lucide-react";

import { AgentWorkingBlob } from "../ui/agent-working-blob";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { projectStatusBlobTone, type ThreadStatusPill } from "./Sidebar.logic.status";

/** Status marker on a collapsed project header; hovering swaps it for an expand chevron. */
export function SidebarProjectStatusIndicator({ status }: { status: ThreadStatusPill }) {
  const blobTone = projectStatusBlobTone(status);
  return (
    <span
      aria-hidden="true"
      title={status.label}
      className={`relative inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
    >
      <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
        {blobTone ? (
          <AgentWorkingBlob tone={blobTone} />
        ) : (
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${status.pulse ? "animate-pulse" : ""}`}
          />
        )}
      </span>
      <ChevronRightIcon
        className={`absolute inset-0 m-auto ${SIDEBAR_ICON_SIZE_CLASS} translate-x-1 text-muted-foreground/70 opacity-0 transition-all duration-150 group-hover/project-header:translate-x-0 group-hover/project-header:opacity-100`}
      />
    </span>
  );
}
