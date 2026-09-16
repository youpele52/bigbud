import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { useState } from "react";

import { getVisibleThreadsForProject } from "~/components/sidebar/Sidebar.logic";

import { MobileListLink } from "../shell/MobileAppHeader";
import { MobileThreadProviderIcon } from "./MobileThreadProviderIcon";
import { MOBILE_THREAD_PREVIEW_LIMIT } from "../../lib/mobileModels";

export function MobileThreadList({
  threads,
  activeThreadId,
  onSelectThread,
}: {
  threads: ReadonlyArray<OrchestrationThread>;
  activeThreadId?: ThreadId | undefined;
  onSelectThread?: ((threadId: ThreadId) => void) | undefined;
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
      {visibleThreads.map((thread) =>
        onSelectThread ? (
          <button
            className="mx-1 flex min-h-11 w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground active:bg-accent/50"
            key={thread.id}
            onClick={() => onSelectThread(thread.id)}
            type="button"
          >
            <MobileThreadProviderIcon thread={thread} />
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          </button>
        ) : (
          <MobileListLink
            key={thread.id}
            icon={<MobileThreadProviderIcon thread={thread} />}
            params={{ threadId: thread.id }}
            to="/mobile/thread/$threadId"
          >
            {thread.title}
          </MobileListLink>
        ),
      )}
      {hasHiddenThreads ? (
        <button
          className="mx-1 flex min-h-11 w-[calc(100%-0.5rem)] items-center rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors active:bg-accent/50 active:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "Show less" : `See more (${hiddenThreads.length})`}
        </button>
      ) : null}
    </div>
  );
}
