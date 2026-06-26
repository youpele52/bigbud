import { type WorkLogEntry } from "@bigbud/shared/workLog";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/cn";

import { MobileWorkLogEntry } from "./MobileWorkLogEntry";

interface MobileWorkLogProps {
  entries: ReadonlyArray<WorkLogEntry>;
  defaultExpanded?: boolean;
}

export function MobileWorkLog({ entries, defaultExpanded = true }: MobileWorkLogProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <button
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Work log ({entries.length})
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col">
          {entries.map((entry) => (
            <MobileWorkLogEntry key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
