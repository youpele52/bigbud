import { realpath, stat } from "node:fs/promises";

import { CLIPROXY_RECOMMENDED_VERSION } from "@bigbud/contracts/constants/cliProxy.constant.ts";
import type { CliProxyVersion } from "@bigbud/contracts/server/server.providers.ts";

import { resolveCommandPath } from "../../../utils/commandPath.ts";
import { runProcess } from "../../../utils/processRunner.ts";

export interface CliProxyInstallation {
  readonly version: string | null;
  readonly installation: "homebrew" | "unknown";
}

const UNKNOWN_INSTALLATION: CliProxyInstallation = { version: null, installation: "unknown" };

/** Compare only stable release identifiers; dev and prerelease builds are not qualified. */
export function stableCliProxyVersion(value: string | null): string | null {
  const match = value?.trim().match(/^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/);
  if (!match || !match[1]!.split(".").every((part) => Number.isSafeInteger(Number(part)))) {
    return null;
  }
  return match[1]!;
}

function isOlder(value: string | null): boolean {
  const version = stableCliProxyVersion(value);
  if (!version) return false;
  const baseline = CLIPROXY_RECOMMENDED_VERSION.split(".").map(Number);
  const parts = version.split(".").map(Number);
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== baseline[index]) return parts[index]! < baseline[index]!;
  }
  return false;
}

/** Runtime evidence takes precedence, even when the installed binary disagrees. */
export function cliProxyVersionMetadata(
  runtimeVersion: string | null,
  installed: CliProxyInstallation,
): CliProxyVersion {
  return {
    recommendedVersion: CLIPROXY_RECOMMENDED_VERSION,
    runtimeVersion,
    installedVersion: installed.version,
    installation: installed.installation,
    ...(isOlder(runtimeVersion)
      ? { updateSource: "runtime" as const }
      : runtimeVersion === null && isOlder(installed.version)
        ? { updateSource: "installed" as const }
        : {}),
  };
}

/** Recognize the formula's canonical Cellar layout, not just a binary named cliproxyapi. */
export function isHomebrewCliProxyPath(binary: string): boolean {
  return /^(?:\/opt\/homebrew|\/usr\/local|\/home\/linuxbrew\/\.linuxbrew)\/Cellar\/cliproxyapi\/[^/]+\/bin\/cliproxyapi$/.test(
    binary,
  );
}

export function makeCliProxyInstallationInspector(
  options: {
    readonly resolve?: typeof resolveCommandPath;
    readonly realpath?: typeof realpath;
    readonly stat?: typeof stat;
    readonly run?: typeof runProcess;
  } = {},
): () => Promise<CliProxyInstallation> {
  const resolve = options.resolve ?? resolveCommandPath;
  const canonicalize = options.realpath ?? realpath;
  const fileStat = options.stat ?? stat;
  const run = options.run ?? runProcess;
  let cached: { key: string; expiresAt: number; result: Promise<CliProxyInstallation> } | undefined;

  return async () => {
    try {
      const binary = resolve("cliproxyapi") ?? resolve("cli-proxy-api");
      if (!binary) return UNKNOWN_INSTALLATION;
      const canonical = await canonicalize(binary);
      const info = await fileStat(canonical);
      const key = `${canonical}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`;
      if (cached?.key === key && cached.expiresAt > Date.now()) return cached.result;
      const result = (async (): Promise<CliProxyInstallation> => {
        try {
          // Go's help flag exits before startup. Never use unsupported --version or management APIs.
          const output = await run(binary, ["--help"], {
            timeoutMs: 2_000,
            settleOnTimeout: true,
            maxBufferBytes: 4_000,
            outputMode: "truncate",
            allowNonZeroExit: true,
            shell: false,
          });
          if (output.timedOut || output.code !== 0) return UNKNOWN_INSTALLATION;
          const version = `${output.stdout}\n${output.stderr}`.match(
            /CLIProxyAPI Version:\s*([^,\s]+)/,
          )?.[1];
          return {
            version: stableCliProxyVersion(version ?? null),
            installation: isHomebrewCliProxyPath(canonical) ? "homebrew" : "unknown",
          };
        } catch {
          return UNKNOWN_INSTALLATION;
        }
      })();
      // Cache failures too; binary replacement invalidates immediately, polling avoids extra spawns.
      cached = { key, expiresAt: Date.now() + 300_000, result };
      return result;
    } catch {
      return UNKNOWN_INSTALLATION;
    }
  };
}

export const inspectCliProxyInstallation = makeCliProxyInstallationInspector();
