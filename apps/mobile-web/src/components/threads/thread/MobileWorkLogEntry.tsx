import { type WorkLogEntry } from "@bigbud/shared/workLog";
import { workEntryDetailBlocks, workEntryPreview } from "@bigbud/shared/workLogPresentation";
import { useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";

import { cn } from "../../../lib/cn";

function workEntryHeading(entry: WorkLogEntry): string {
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "Command";
  }
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") {
    return "Read file";
  }
  if (entry.requestKind === "file-change" || entry.itemType === "file_change") {
    return "Changed files";
  }
  if (entry.itemType === "web_search") {
    return "Searched files";
  }
  if (
    entry.itemType === "mcp_tool_call" ||
    entry.itemType === "dynamic_tool_call" ||
    entry.itemType === "collab_agent_tool_call"
  ) {
    return entry.toolTitle ?? "Tool";
  }
  return entry.label;
}

function workToneClass(tone: WorkLogEntry["tone"]): string {
  if (tone === "error") return "text-destructive";
  if (tone === "tool") return "text-muted-foreground/80";
  if (tone === "thinking") return "text-muted-foreground/70";
  return "text-muted-foreground/60";
}

function workEntryIcon(entry: WorkLogEntry) {
  if (entry.tone === "error") return CircleAlertIcon;
  if (entry.itemType === "command_execution" || entry.command) return TerminalIcon;
  if (
    entry.itemType === "mcp_tool_call" ||
    entry.itemType === "dynamic_tool_call" ||
    entry.itemType === "collab_agent_tool_call"
  )
    return WrenchIcon;
  if (entry.tone === "thinking") return BotIcon;
  return CheckIcon;
}

interface MobileWorkLogEntryProps {
  entry: WorkLogEntry;
}

export function MobileWorkLogEntry({ entry }: MobileWorkLogEntryProps) {
  const Icon = workEntryIcon(entry);
  const heading = workEntryHeading(entry);
  const preview = workEntryPreview(entry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const blocks = workEntryDetailBlocks(entry);

  return (
    <div className="flex min-w-0 items-start gap-2 py-1">
      <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center text-foreground/80">
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn("truncate text-xs leading-5", workToneClass(entry.tone))}
          title={displayText}
        >
          <span className="text-foreground/85">{heading}</span>
          {preview ? <span className="text-muted-foreground/65"> - {preview}</span> : null}
        </p>
        {blocks.length > 0 ? <MobileWorkEntryDetails blocks={blocks} /> : null}
      </div>
    </div>
  );
}

/** Native disclosure keeps the full payload local and avoids materializing large closed text. */
function MobileWorkEntryDetails({ blocks }: { readonly blocks: ReadonlyArray<string> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      data-work-entry-details=""
      className="group mt-1"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 w-full cursor-pointer list-none items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3.5 -rotate-90 transition-transform group-open:rotate-0"
        />
        <span>Details</span>
      </summary>
      {expanded ? (
        <div className="space-y-1.5">
          {blocks.map((block) => (
            <pre
              key={block}
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/45 p-2 font-mono text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere]"
            >
              {block}
            </pre>
          ))}
        </div>
      ) : null}
    </details>
  );
}
