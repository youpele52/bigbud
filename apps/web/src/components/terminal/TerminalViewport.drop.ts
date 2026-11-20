import { BIGBUD_FILES_PANEL_DRAG_MIME, parseFilesPanelDragEntry } from "../files/filesPanel.dnd";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";

/** Explicit WSL sessions cannot forward host/file-panel paths to unsupported workspace APIs. */
export function rejectWslTerminalFileDrop(
  target: string | undefined,
  notice: (message: string) => void,
): boolean {
  if (!isWslTerminalTargetId(target)) return false;
  notice(
    "File drops are unavailable for WSL terminals. Enter a path inside the selected distro instead.",
  );
  return true;
}

export type DroppedTerminalPath =
  | { readonly path: string; readonly origin: "internal" }
  /** `path` is empty when the platform exposes no native path (browsers, phones). */
  | { readonly path: string; readonly origin: "native"; readonly file: File };

export function acceptsTerminalDrop(types: ReadonlyArray<string>): boolean {
  return types.includes(BIGBUD_FILES_PANEL_DRAG_MIME) || types.includes("Files");
}

export function readDroppedTerminalPaths(input: {
  dataTransfer: Pick<DataTransfer, "files" | "getData" | "types">;
  readNativeFilePath: (file: File) => string;
}): ReadonlyArray<DroppedTerminalPath> {
  if (input.dataTransfer.types.includes(BIGBUD_FILES_PANEL_DRAG_MIME)) {
    const payload = parseFilesPanelDragEntry(
      input.dataTransfer.getData(BIGBUD_FILES_PANEL_DRAG_MIME),
    );
    if (payload) {
      return [{ path: payload.path, origin: "internal" }];
    }
  }

  return Array.from(input.dataTransfer.files, (file) => ({
    path: input.readNativeFilePath(file),
    origin: "native" as const,
    file,
  }));
}
