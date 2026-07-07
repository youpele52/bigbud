import { type TerminalDropPathMode } from "@bigbud/contracts";
import { type Terminal } from "@xterm/xterm";

import { BIGBUD_FILES_PANEL_DRAG_MIME, parseFilesPanelDragEntry } from "../files/filesPanel.dnd";

export interface DroppedTerminalPath {
  readonly path: string;
  readonly origin: "internal" | "native";
}

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

  const paths = Array.from(input.dataTransfer.files, input.readNativeFilePath).filter(
    (path) => path.length > 0,
  );
  return paths.map((path) => ({ path, origin: "native" }));
}

function quotePosixPath(path: string): string {
  if (path.length === 0) {
    return "''";
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShellPath(path: string): string {
  if (path.length === 0) {
    return "''";
  }
  return `'${path.replaceAll("'", "''")}'`;
}

function quoteWindowsPath(path: string): string {
  if (path.length === 0) {
    return '""';
  }
  return `"${path.replaceAll('"', '""')}"`;
}

function normalizeWindowsDrivePath(path: string): { drive: string; rest: string } | null {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return null;
  }
  return {
    drive: match[1]!.toLowerCase(),
    rest: match[2]!.replaceAll("\\", "/"),
  };
}

function toMsysPath(path: string): string {
  const drivePath = normalizeWindowsDrivePath(path);
  if (drivePath) {
    return `/${drivePath.drive}/${drivePath.rest}`;
  }
  if (path.startsWith("\\\\")) {
    return `//${path.slice(2).replaceAll("\\", "/")}`;
  }
  return path;
}

function toWslPath(path: string): string {
  const drivePath = normalizeWindowsDrivePath(path);
  if (drivePath) {
    return `/mnt/${drivePath.drive}/${drivePath.rest}`;
  }
  if (path.startsWith("\\\\")) {
    return `//${path.slice(2).replaceAll("\\", "/")}`;
  }
  return path;
}

export function formatDroppedTerminalPath(
  path: string,
  dropPathMode: TerminalDropPathMode,
): string {
  if (dropPathMode === "cmd") {
    return quoteWindowsPath(path);
  }
  if (dropPathMode === "powershell") {
    return quotePowerShellPath(path);
  }

  const normalizedPath =
    dropPathMode === "wsl" ? toWslPath(path) : dropPathMode === "msys" ? toMsysPath(path) : path;
  return quotePosixPath(normalizedPath);
}

export function pasteDroppedTerminalPaths(input: {
  terminal: Pick<Terminal, "focus" | "paste"> | null;
  paths: ReadonlyArray<string>;
  dropPathMode: TerminalDropPathMode;
}): boolean {
  if (!input.terminal || input.paths.length === 0) {
    return false;
  }

  input.terminal.focus();
  input.terminal.paste(
    input.paths.map((path) => formatDroppedTerminalPath(path, input.dropPathMode)).join(" "),
  );
  return true;
}
