import { isRemoteExecutionTargetId, type ExecutionTargetId } from "@bigbud/contracts";
import { TERMINAL_PASTE_WSL_UNAVAILABLE_MESSAGE } from "@bigbud/contracts/workspace/terminal.paste.ts";
import { isAbsolutePath } from "@bigbud/shared/path";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import type { DroppedTerminalPath } from "./TerminalViewport.drop";

export type TerminalPasteHostKind = "local" | "remote" | "wsl";

/** One file to land in the terminal: an existing absolute path, or bytes to stage first. */
export type TerminalPasteItem =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "stage"; readonly file: File };

export type TerminalPastePlan =
  /** Leave the event to xterm (plain text, or nothing bigbud handles). */
  | { readonly kind: "passthrough" }
  | { readonly kind: "reject"; readonly message: string }
  | { readonly kind: "deliver"; readonly items: ReadonlyArray<TerminalPasteItem> };

export function terminalPasteHostKind(target: string | undefined): TerminalPasteHostKind {
  if (isWslTerminalTargetId(target)) return "wsl";
  return isRemoteExecutionTargetId(target as ExecutionTargetId | undefined) ? "remote" : "local";
}

export interface PastedTerminalFile {
  readonly file: File;
  /** Native absolute path from the desktop bridge, or "" when unavailable. */
  readonly nativePath: string;
}

/**
 * A Finder copy also carries the file *name* as `text/plain`; that text is not meaningful text.
 * Any other non-blank text wins over files (text paste stays exactly as before).
 */
function isMeaningfulText(text: string, files: ReadonlyArray<PastedTerminalFile>): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const names = files.map((entry) => entry.file.name);
  return !(
    names.length > 0 &&
    (trimmed === names.join("\n") || trimmed === names.join(" ") || names.includes(trimmed))
  );
}

/** Local files with a real absolute path paste that path; everything else is staged. */
function itemFor(entry: PastedTerminalFile, host: TerminalPasteHostKind): TerminalPasteItem {
  return host === "local" && isAbsolutePath(entry.nativePath)
    ? { kind: "path", path: entry.nativePath }
    : { kind: "stage", file: entry.file };
}

/** Classifies a paste gesture. Ctrl+V never reaches this: only DOM paste events do. */
export function planTerminalPaste(input: {
  readonly text: string;
  readonly files: ReadonlyArray<PastedTerminalFile>;
  readonly host: TerminalPasteHostKind;
}): TerminalPastePlan {
  if (input.files.length === 0 || isMeaningfulText(input.text, input.files))
    return { kind: "passthrough" };
  if (input.host === "wsl")
    return { kind: "reject", message: TERMINAL_PASTE_WSL_UNAVAILABLE_MESSAGE };
  return { kind: "deliver", items: input.files.map((entry) => itemFor(entry, input.host)) };
}

/**
 * Drops: files-panel paths already name the terminal's machine; native local files paste their
 * path; native files dropped on a remote terminal are uploaded there (never silently dropped).
 * Relative paths are never pasted.
 */
export function planTerminalDrop(input: {
  readonly dropped: ReadonlyArray<DroppedTerminalPath>;
  readonly host: TerminalPasteHostKind;
}): TerminalPastePlan {
  if (input.dropped.length === 0) return { kind: "passthrough" };
  if (input.host === "wsl")
    return { kind: "reject", message: TERMINAL_PASTE_WSL_UNAVAILABLE_MESSAGE };
  const items: TerminalPasteItem[] = [];
  for (const entry of input.dropped) {
    if (entry.origin === "internal") {
      if (isAbsolutePath(entry.path)) items.push({ kind: "path", path: entry.path });
    } else items.push(itemFor({ file: entry.file, nativePath: entry.path }, input.host));
  }
  return items.length > 0
    ? { kind: "deliver", items }
    : { kind: "reject", message: "Only files with a full path can be dropped here." };
}

/** Standard base64 for one upload chunk, built in slices to stay under argument limits. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
