import { createRequire } from "node:module";

import {
  RuntimeConnection,
  type CopilotClientOptions,
  type RuntimeConnection as CopilotRuntimeConnection,
  type SessionFsConfig,
} from "@github/copilot-sdk";

const DEFAULT_BINARY_PATH = "copilot";

export interface CopilotRuntimeInvocation {
  readonly path: string;
  readonly args: ReadonlyArray<string>;
  readonly source: "configured" | "bundled-native";
}

interface RuntimePlatform {
  readonly arch: string;
  readonly platform: NodeJS.Platform;
  readonly isMusl: boolean;
}

function isLinuxMusl(): boolean {
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: string } }
    | undefined;
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime;
}

export function copilotNativePackageName(input: RuntimePlatform): string | undefined {
  switch (input.platform) {
    case "darwin":
      return input.arch === "arm64" || input.arch === "x64"
        ? `@github/copilot-darwin-${input.arch}`
        : undefined;
    case "win32":
      return input.arch === "arm64" || input.arch === "x64"
        ? `@github/copilot-win32-${input.arch}`
        : undefined;
    case "linux": {
      if (input.arch !== "arm64" && input.arch !== "x64") return undefined;
      return `@github/copilot-linux${input.isMusl ? "musl" : ""}-${input.arch}`;
    }
    default:
      return undefined;
  }
}

export function resolveCopilotRuntimeInvocation(
  binaryPath: string,
  input: {
    readonly isElectron?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly isMusl?: boolean;
    readonly resolve?: (id: string) => string;
  } = {},
): CopilotRuntimeInvocation | undefined {
  if (binaryPath !== DEFAULT_BINARY_PATH) {
    return { path: binaryPath, args: [], source: "configured" };
  }

  if (input.isElectron ?? "electron" in process.versions) {
    const packageName = copilotNativePackageName({
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      isMusl: input.isMusl ?? isLinuxMusl(),
    });
    if (!packageName) {
      throw new Error(
        `No bundled Copilot runtime is available for ${input.platform ?? process.platform}/${input.arch ?? process.arch}`,
      );
    }

    try {
      const require = createRequire(import.meta.url);
      const resolve =
        input.resolve ?? createRequire(require.resolve("@github/copilot-sdk")).resolve;
      return {
        path: resolve(packageName),
        args: [],
        source: "bundled-native",
      };
    } catch (cause) {
      throw new Error(`Unable to resolve the bundled Copilot runtime package ${packageName}`, {
        cause,
      });
    }
  }

  return undefined;
}

export function makeCliRuntimeConnection(
  invocation: CopilotRuntimeInvocation | undefined,
): CopilotRuntimeConnection | undefined {
  return invocation === undefined
    ? undefined
    : RuntimeConnection.forStdio({ path: invocation.path, args: invocation.args });
}

export function makeCopilotClientOptions(input: {
  readonly binaryPath: string;
  readonly workingDirectory?: string;
  readonly sessionFs?: SessionFsConfig;
}): CopilotClientOptions {
  const connection = makeCliRuntimeConnection(resolveCopilotRuntimeInvocation(input.binaryPath));
  return {
    ...(connection ? { connection } : {}),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.sessionFs ? { sessionFs: input.sessionFs } : {}),
    logLevel: "error",
  };
}
