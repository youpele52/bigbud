/**
 * Moves a local workspace entry to the operating system's Trash (Recycle Bin), when the
 * platform offers a non-interactive way to do so. Commands run without a shell; the path is a
 * single argument (or, on Windows, an environment variable), never interpolated into a script.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const TRASH_TIMEOUT_MS = 30_000;

export interface WorkspaceTrash {
  /** Whether `moveToTrash` is expected to work on this platform. */
  readonly available: boolean;
  /** Moves `absolutePath` itself (a symlink is moved as a link) to the Trash. */
  readonly moveToTrash: (absolutePath: string) => Promise<void>;
}

interface TrashCommand {
  readonly file: string;
  readonly args: (absolutePath: string) => ReadonlyArray<string>;
  readonly env?: (absolutePath: string) => NodeJS.ProcessEnv;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Windows: Recycle Bin through the .NET VisualBasic file system API; the path comes from env. */
const WINDOWS_RECYCLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "$target = $env:BIGBUD_TRASH_PATH",
  "$item = Get-Item -LiteralPath $target -Force",
  "$options = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs",
  "$recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin",
  "if ($item.PSIsContainer -and -not $item.LinkType) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, $options, $recycle) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, $options, $recycle) }",
].join("; ");

export function resolveTrashCommand(
  platform: NodeJS.Platform = process.platform,
  pathValue: string | undefined = process.env.PATH,
): TrashCommand | undefined {
  if (platform === "darwin") {
    // macOS 15+ ships /usr/bin/trash; it moves the named entry (not a link target) to the Trash.
    // It does not accept "--"; callers pass absolute paths, which cannot be read as options.
    return isExecutable("/usr/bin/trash")
      ? { file: "/usr/bin/trash", args: (absolutePath) => [absolutePath] }
      : undefined;
  }
  if (platform === "win32") {
    const powershell = findOnPath("powershell.exe", pathValue);
    return powershell
      ? {
          file: powershell,
          args: () => ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECYCLE_SCRIPT],
          env: (absolutePath) => ({ ...process.env, BIGBUD_TRASH_PATH: absolutePath }),
        }
      : undefined;
  }
  const gio = findOnPath("gio", pathValue);
  return gio ? { file: gio, args: (absolutePath) => ["trash", "--", absolutePath] } : undefined;
}

export function makeSystemWorkspaceTrash(
  command: TrashCommand | undefined = resolveTrashCommand(),
): WorkspaceTrash {
  if (!command) {
    return {
      available: false,
      moveToTrash: () => Promise.reject(new Error("The system Trash is not available.")),
    };
  }
  return {
    available: true,
    moveToTrash: (absolutePath) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          command.file,
          [...command.args(absolutePath)],
          {
            timeout: TRASH_TIMEOUT_MS,
            windowsHide: true,
            ...(command.env ? { env: command.env(absolutePath) } : {}),
          },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            const detail = String(stderr).trim();
            reject(new Error(`Moving to the Trash failed${detail ? `: ${detail}` : "."}`));
          },
        );
      }),
  };
}
