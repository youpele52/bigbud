import type { DelegatedChildSummary } from "../../../models/types/app.types";
import { cn } from "~/lib/utils";
import { CHAT_COLUMN_CLASS_NAME } from "../common/chatColumn";
import { DelegatedChildRow } from "./DelegatedChildRow";

export function DelegatedChildrenCard(props: { items: ReadonlyArray<DelegatedChildSummary> }) {
  if (props.items.length === 0) return null;
  return (
    <section
      className={cn(
        CHAT_COLUMN_CLASS_NAME,
        "mb-3 rounded-lg border border-border/70 bg-card/70 p-2",
      )}
      aria-label="Delegated threads"
    >
      <div className="px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground">
        DELEGATED THREADS ({props.items.length})
      </div>
      <div className="space-y-1 p-1">
        {props.items.map((child) => (
          <DelegatedChildRow key={child.threadId} child={child} />
        ))}
      </div>
    </section>
  );
}
