import * as FS from "node:fs";
import * as Path from "node:path";

export interface TrustedWindowsPowerShell {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly executablePath: string;
}

interface ResolveTrustedWindowsPowerShellDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly existsSync: (path: string) => boolean;
}

const defaultDeps: ResolveTrustedWindowsPowerShellDeps = {
  env: process.env,
  existsSync: FS.existsSync,
};

function normalizeWindowsRoot(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^[a-z]:[\\/]/i.test(trimmed)) return null;
  return Path.win32.resolve(trimmed);
}

export function resolveTrustedWindowsPowerShell(
  deps: ResolveTrustedWindowsPowerShellDeps = defaultDeps,
): TrustedWindowsPowerShell {
  const systemRoot = normalizeWindowsRoot(deps.env.SystemRoot);
  const windowsDirectory = normalizeWindowsRoot(deps.env.WINDIR);
  if (
    !systemRoot ||
    !windowsDirectory ||
    systemRoot.toLowerCase() !== windowsDirectory.toLowerCase()
  ) {
    throw new Error("Windows update preflight could not establish the trusted Windows directory.");
  }

  const executablePath = Path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!deps.existsSync(executablePath)) {
    throw new Error("Windows update preflight could not find trusted Windows PowerShell 5.1.");
  }

  const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot };
  for (const name of ["TEMP", "TMP"] as const) {
    const value = deps.env[name];
    if (value) env[name] = value;
  }
  return { cwd: systemRoot, env, executablePath };
}
