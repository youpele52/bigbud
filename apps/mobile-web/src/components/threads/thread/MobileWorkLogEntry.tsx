import { type WorkLogEntry } from "@bigbud/shared/workLog";
import { BotIcon, CheckIcon, CircleAlertIcon, TerminalIcon, WrenchIcon } from "lucide-react";

import { cn } from "../lib/cn";

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

function workEntryPreview(entry: WorkLogEntry): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  if ((entry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = entry.changedFiles ?? [];
  if (!firstPath) return null;
  return entry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${entry.changedFiles!.length - 1} more`;
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

  return (
    <div className="flex min-w-0 items-start gap-2 py-1">
      <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center text-foreground/80">
        <Icon className="size-3" />
      </span>
      <p
        className={cn("min-w-0 flex-1 truncate text-xs leading-5", workToneClass(entry.tone))}
        title={displayText}
      >
        <span className="text-foreground/85">{heading}</span>
        {preview ? <span className="text-muted-foreground/65"> - {preview}</span> : null}
      </p>
    </div>
  );
}
