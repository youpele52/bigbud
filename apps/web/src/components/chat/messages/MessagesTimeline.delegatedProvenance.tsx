import { ChevronDownIcon } from "lucide-react";
import type { ParsedDelegatedThreadProvenance } from "~/lib/terminalContext";

export function MessagesTimelineDelegatedProvenance(props: {
  provenance: ParsedDelegatedThreadProvenance | null;
}) {
  if (!props.provenance) return null;

  return (
    <details className="mb-2 group/delegation">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground/70">
        <ChevronDownIcon className="size-3 shrink-0 -rotate-90 transition-transform duration-150 group-open/delegation:rotate-0" />
        Delegation details
      </summary>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-background/45 p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
        {props.provenance.body}
      </pre>
    </details>
  );
}
