import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";

export type TimelineWorkEntry = Extract<
  MessagesTimelineRow,
  { kind: "work" }
>["groupedEntries"][number];

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

export function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive-foreground/80";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/65";
  return "text-muted-foreground/40";
}

export function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
): string | null {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

export function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "browser") return GlobeIcon;
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  const isBrowserTool =
    workEntry.toolTitle && /browser|navigate|screenshot|web_search/i.test(workEntry.toolTitle);

  if (isBrowserTool) return GlobeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function browserToolHeading(toolTitle: string, action: string | undefined): string | null {
  if (
    toolTitle !== "browser" &&
    !/^bigbud_orchestration(?:_[\w-]+)?_browser$/.test(toolTitle) &&
    toolTitle !== "mcp__bigbud_orchestration__browser"
  ) {
    return null;
  }

  switch (action) {
    case "capture":
      return "Captured browser";
    case "navigate":
      return "Navigating browser";
    case "click":
      return "Clicking browser";
    case "drag":
      return "Dragging in browser";
    case "scroll":
      return "Scrolling browser";
    case "type":
      return "Typing in browser";
    case "key":
      return "Pressing key in browser";
    case "wait":
      return "Waiting for browser";
    case "get_page_info":
      return "Reading page information";
    case "get_page_text":
      return "Reading page text";
    case "go_back":
      return "Going back in browser";
    case "go_forward":
      return "Going forward in browser";
    case "reload":
      return "Reloading browser";
    case "release_tab":
      return "Releasing browser tab";
    case "close_tab":
      return "Closing browser tab";
    default:
      return "Browser";
  }
}

export function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  const browserHeading = workEntry.toolTitle
    ? browserToolHeading(workEntry.toolTitle, workEntry.toolAction)
    : null;
  if (browserHeading) {
    return browserHeading;
  }
  const heading = capitalizePhrase(
    normalizeCompactToolLabel(workEntry.toolTitle || workEntry.label),
  );
  // Only normalize the namespace prefix of a structured tool label, not its suffix or prose.
  return heading.replace(/^(mcp__)?bigbud_orchestration(?=$|:|_)/i, "$1bigbud_orchestration");
}

export function workEntryCopyText(workEntry: TimelineWorkEntry): string {
  const lines: string[] = [];
  const appendLine = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    if (lines.at(-1) === trimmed) {
      return;
    }
    lines.push(trimmed);
  };

  appendLine(toolWorkEntryHeading(workEntry));
  appendLine(workEntryRawCommand(workEntry) ?? workEntry.command ?? workEntry.detail);
  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    appendLine(`Changed files:\n${workEntry.changedFiles!.join("\n")}`);
  }

  return lines.join("\n");
}
