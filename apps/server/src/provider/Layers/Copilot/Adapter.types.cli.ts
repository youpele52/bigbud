import { createRequire } from "node:module";

import {
  RuntimeConnection,
  type CopilotClientOptions,
  type RuntimeConnection as CopilotRuntimeConnection,
  type SessionFsConfig,
} from "@github/copilot-sdk";

import { readManagedCopilotRuntime } from "@bigbud/shared/copilotRuntime.paths";
import { copilotNativePackageName } from "./Runtime.release.ts";
import { resolveExternalCopilot, sdkCopilotExecutable } from "./Runtime.executable.ts";

export { copilotNativePackageName } from "./Runtime.release.ts";

const DEFAULT_BINARY_PATH = "copilot";
let detectedLinuxMusl: boolean | undefined;

export interface CopilotRuntimeInvocation {
  readonly path: string;
  readonly args: ReadonlyArray<string>;
  readonly source: "configured" | "managed" | "bundled-native" | "existing" | "sdk";
}

function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  if (detectedLinuxMusl !== undefined) return detectedLinuxMusl;
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: string } }
    | undefined;
  detectedLinuxMusl = !report?.header?.glibcVersionRuntime;
  return detectedLinuxMusl;
}

export function resolveCopilotRuntimeInvocation(
  binaryPath: string,
  input: {
    readonly isElectron?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly isMusl?: boolean;
    readonly resolve?: (id: string) => string;
    readonly managedRoot?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly resolveSdk?: (target: string) => string | undefined;
  } = {},
): CopilotRuntimeInvocation | undefined {
  if (!binaryPath.trim()) binaryPath = DEFAULT_BINARY_PATH;
  const environment = input.env ?? process.env;
  const packageName = copilotNativePackageName({
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    isMusl: input.isMusl ?? isLinuxMusl(),
  });
  const configured = binaryPath !== DEFAULT_BINARY_PATH ? binaryPath : environment.COPILOT_CLI_PATH;
  if (configured) {
    const existing = resolveExternalCopilot(configured, packageName, environment);
    if (existing) return { path: existing, args: [], source: "configured" };
  }
  const managed = readManagedCopilotRuntime(input.managedRoot);
  // An Intel bridge running under Rosetta can be followed by a native arm64 app update.
  const compatibleIntelMigration =
    (input.platform ?? process.platform) === "darwin" &&
    (input.arch ?? process.arch) === "arm64" &&
    managed?.target === "darwin-x64";
  if (
    managed &&
    (packageName === `@github/copilot-${managed.target}` || compatibleIntelMigration)
  ) {
    return { path: managed.path, args: [], source: "managed" };
  }
  // Stale configured bundle paths can disappear in a slim upgrade. Prefer a preserved managed copy.
  if (configured) return { path: configured, args: [], source: "configured" };

  // Bridge compatibility: do not remove this fallback until existing users have migrated.
  if (
    input.isElectron ??
    ("electron" in process.versions || environment.BIGBUD_DESKTOP_PACKAGED === "1")
  ) {
    if (!packageName) {
      throw new Error(
        `No bundled Copilot runtime is available for ${input.platform ?? process.platform}/${input.arch ?? process.arch}`,
      );
    }

    try {
      const require = createRequire(import.meta.url);
      const resolve =
        input.resolve ?? createRequire(require.resolve("@github/copilot/package.json")).resolve;
      return {
        path: resolve(packageName),
        args: [],
        source: "bundled-native",
      };
    } catch (cause) {
      const existing = resolveExternalCopilot("copilot", packageName, environment);
      if (existing) return { path: existing, args: [], source: "existing" };
      const sdk = (input.resolveSdk ?? sdkCopilotExecutable)(
        packageName.slice("@github/copilot-".length),
      );
      if (sdk) return { path: sdk, args: [], source: "sdk" };
      throw new Error(
        `Unable to resolve the bundled Copilot runtime package ${packageName}. Runtime not found; install Copilot in Settings → Providers → GitHub Copilot.`,
        {
          cause,
        },
      );
    }
  }

  const existing = resolveExternalCopilot("copilot", packageName, environment);
  if (existing) return { path: existing, args: [], source: "existing" };
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
