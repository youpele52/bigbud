import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { useState } from "react";

import { getVisibleThreadsForProject } from "~/components/sidebar/Sidebar.logic";

import { MobileListLink } from "../shell/MobileAppHeader";
import { MobileThreadProviderIcon } from "./MobileThreadProviderIcon";
import { MOBILE_THREAD_PREVIEW_LIMIT } from "../../lib/mobileModels";

export function MobileThreadList({
  threads,
  activeThreadId,
}: {
  threads: ReadonlyArray<OrchestrationThread>;
  activeThreadId?: ThreadId | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const { hasHiddenThreads, hiddenThreads, visibleThreads } = getVisibleThreadsForProject({
    threads,
    activeThreadId,
    isThreadListExpanded: expanded,
    previewLimit: MOBILE_THREAD_PREVIEW_LIMIT,
  });

  return (
    <div className="pl-3 pr-1">
      {visibleThreads.map((thread) => (
        <MobileListLink
          key={thread.id}
          icon={<MobileThreadProviderIcon thread={thread} />}
          params={{ threadId: thread.id }}
          to="/mobile/thread/$threadId"
        >
          {thread.title}
        </MobileListLink>
      ))}
      {hasHiddenThreads ? (
        <button
          className="mx-1 w-[calc(100%-0.5rem)] rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors active:bg-accent/50 active:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "Show less" : `See more (${hiddenThreads.length})`}
        </button>
      ) : null}
    </div>
  );
}
