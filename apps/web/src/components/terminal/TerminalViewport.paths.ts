import { type TerminalDropPathMode } from "@bigbud/contracts";

/** Absolute on POSIX or Windows (drive or UNC). Relative, `~` and bare names never qualify. */
export function isAbsoluteTerminalPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function quotePosixPath(path: string): string {
  if (path.length === 0) {
    return "''";
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Backslash-escapes every ASCII character outside a shell-safe set. Codex (shlex, one token),
 * Claude Code and OpenCode (strip quotes, then `\x` unescape), Gemini CLI (quote/backslash aware
 * splitter) and every POSIX shell all read this form, including names with spaces and
 * apostrophes, where single quotes break Claude Code and OpenCode. A backslash-newline is a
 * shell line continuation, so paths with control characters fall back to single quotes.
 */
export function escapePosixPath(path: string): string {
  // oxlint-disable-next-line no-control-regex -- Control characters cannot be backslash-escaped.
  if (path.length === 0 || /[\x00-\x1f\x7f]/.test(path)) return quotePosixPath(path);
  return path.replace(/[^A-Za-z0-9_./,:+@%=\-\u0080-￿]/g, (character) => `\\${character}`);
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

/** One pasted or dropped path in the form the pane's shell family reads as a single word. */
export function formatTerminalPath(path: string, dropPathMode: TerminalDropPathMode): string {
  if (dropPathMode === "cmd") {
    return quoteWindowsPath(path);
  }
  if (dropPathMode === "powershell") {
    return quotePowerShellPath(path);
  }
  if (dropPathMode === "posix") {
    return escapePosixPath(path);
  }
  // Legacy Windows-hosted POSIX shells keep their quoting (WSL staging is out of scope).
  return quotePosixPath(dropPathMode === "wsl" ? toWslPath(path) : toMsysPath(path));
}

/** Mirrors xterm's paste: CRLF to CR, ESC neutralised, bracketed when the program asked for it. */
export function formatTerminalPaste(text: string, bracketedPasteMode: boolean): string {
  const prepared = text.replace(/\r?\n/g, "\r");
  if (!bracketedPasteMode) return prepared;
  // oxlint-disable-next-line no-control-regex -- ESC must not end the bracketed paste early.
  return `\x1b[200~${prepared.replace(/\x1b/g, "␛")}\x1b[201~`;
}

/**
 * Several paths become one bracketed paste each, separated by a typed space: Codex attaches an
 * image only when a paste contains exactly one path.
 */
export function formatTerminalPathPastes(
  paths: ReadonlyArray<string>,
  dropPathMode: TerminalDropPathMode,
  bracketedPasteMode: boolean,
): string {
  return paths
    .map((path) => formatTerminalPaste(formatTerminalPath(path, dropPathMode), bracketedPasteMode))
    .join(" ");
}
