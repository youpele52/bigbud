import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const DEFAULT_PI_BINARY_PATH = "pi";

export interface PiInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly bundledCliPath?: string;
}

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
