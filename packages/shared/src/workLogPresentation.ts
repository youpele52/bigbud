import type { WorkLogEntry } from "./workLog/workLog";

export function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
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
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

/** Characters of command or detail text that comfortably fit the truncated inline preview. */
export const WORK_ENTRY_INLINE_PREVIEW_MAX_CHARS = 80;

/**
 * Full text blocks for the collapsed "Details" disclosure under a work entry: the complete
 * (raw) command and any detail it hides. Empty when the inline preview already shows it all.
 */
export function workEntryDetailBlocks(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand" | "detail">,
): string[] {
  const command = workEntry.command?.trim() || undefined;
  const fullCommand = workEntryRawCommand(workEntry) ?? command;
  const detail = workEntry.detail?.trim() || undefined;
  const hiddenDetail = detail && detail !== command && detail !== fullCommand ? detail : undefined;
  const blocks = [fullCommand, hiddenDetail].filter((block): block is string => Boolean(block));
  const inlinePreview = command ?? detail;
  const exceedsPreview = blocks.some(
    (block) =>
      block !== inlinePreview ||
      block.includes("\n") ||
      block.length > WORK_ENTRY_INLINE_PREVIEW_MAX_CHARS,
  );
  return exceedsPreview ? blocks : [];
}
