import type { ThreadDetailDelegatedChild } from "@bigbud/contracts/orchestration/orchestration.detail.ts";

import { ThreadOriginLink } from "../messages/ThreadOriginLink";

export function DelegatedChildrenCard(props: { items: ReadonlyArray<ThreadDetailDelegatedChild> }) {
  if (props.items.length === 0) return null;
  return (
    <section
      className="mb-3 rounded-lg border border-border/70 bg-card/70 p-2"
      aria-label="Delegated threads"
    >
      <div className="px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground">
        DELEGATED THREADS ({props.items.length})
      </div>
      <div className="space-y-1 p-1">
        {props.items.map((child) => (
          <div key={child.threadId} className="flex items-center justify-between gap-2">
            <ThreadOriginLink
              threadId={child.threadId}
              title={child.title}
              available={child.workflowState !== "unavailable"}
            />
            <span className="text-xs capitalize text-muted-foreground">{child.workflowState}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
