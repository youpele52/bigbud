import os from "node:os";
import path from "node:path";

export type SshConfigRootKind = "user" | "system";

export interface SshConfigRoot {
  readonly kind: SshConfigRootKind;
  readonly path: string;
  /** Directory OpenSSH resolves relative `Include` paths against for this root. */
  readonly includeBaseDir: string;
}

/** OpenSSH client-config files read on this machine, in OpenSSH's precedence order. */
export function defaultSshConfigRoots(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<SshConfigRoot> {
  const userDir = path.join(homeDir, ".ssh");
  const systemDir =
    platform === "win32" ? path.join(env.ProgramData ?? "C:\\ProgramData", "ssh") : "/etc/ssh";
  return [
    { kind: "user", path: path.join(userDir, "config"), includeBaseDir: userDir },
    { kind: "system", path: path.join(systemDir, "ssh_config"), includeBaseDir: systemDir },
  ];
}

export function expandSshConfigHome(filePath: string, homeDir: string): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

/** Shortens paths under the home directory to `~/...` for display. */
export function displaySshConfigPath(filePath: string, homeDir: string): string {
  const relative = path.relative(homeDir, filePath);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return filePath;
}
