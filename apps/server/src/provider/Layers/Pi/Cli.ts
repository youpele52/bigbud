import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const DEFAULT_PI_BINARY_PATH = "pi";

export interface PiInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly bundledCliPath?: string;
}

const WINDOWS_COMMAND_SCRIPT_PATTERN = /\.(?:bat|cmd)$/i;

export function resolveBundledPiCliPath(): string | undefined {
  const req = createRequire(import.meta.url);

  const tryResolve = (packageName: string): string | undefined => {
    try {
      const packageJsonPath = req.resolve(`${packageName}/package.json`);
      const packageDir = dirname(packageJsonPath);
      const cliPath = join(packageDir, "dist", "cli.js");
      return existsSync(cliPath) ? cliPath : undefined;
    } catch {
      return undefined;
    }
  };

  return (
    tryResolve("@earendil-works/pi-coding-agent") ?? tryResolve("@mariozechner/pi-coding-agent")
  );
}

function resolveNodeCommand(): string {
  if (process.versions.bun) {
    return "node";
  }

  return process.execPath;
}

export function resolvePiInvocation(binaryPath: string): PiInvocation {
  if (binaryPath !== DEFAULT_PI_BINARY_PATH) {
    return {
      command: binaryPath,
      args: [],
    };
  }

  const bundledCliPath = resolveBundledPiCliPath();
  if (!bundledCliPath) {
    return {
      command: DEFAULT_PI_BINARY_PATH,
      args: [],
    };
  }

  return {
    command: resolveNodeCommand(),
    args: [bundledCliPath],
    bundledCliPath,
  };
}

export function buildPiRpcInvocation(
  binaryPath: string,
  extraArgs: ReadonlyArray<string> = [],
): PiInvocation {
  const invocation = resolvePiInvocation(binaryPath);
  return {
    ...invocation,
    args: [...invocation.args, "--mode", "rpc", ...extraArgs],
  };
}

function stripWindowsShellQuotes(command: string): string {
  return command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command;
}

export function shouldUseWindowsPiShell(command: string): boolean {
  if (process.platform !== "win32") return false;

  const unquoted = stripWindowsShellQuotes(command);
  return unquoted === DEFAULT_PI_BINARY_PATH || WINDOWS_COMMAND_SCRIPT_PATTERN.test(unquoted);
}

export function quoteWindowsPiShellCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (!/\s/.test(command)) return command;
  if (command.startsWith('"') && command.endsWith('"')) return command;

  return `"${command}"`;
}
