/**
 * Stable machine identity for durable ownership records (backend lock, thread-tools markers).
 *
 * Hostnames are not stable: macOS renames the host with the network (`name.local` vs
 * `name.fritz.box`). The platform id survives that: macOS `IOPlatformUUID` (ioreg), Linux
 * `/etc/machine-id` or `/var/lib/dbus/machine-id`. The raw id is never stored; records carry an
 * app-scoped SHA-256 digest of it. `null` when unavailable: callers then keep the hostname rule.
 * Computed once per process; the ioreg call runs under a fixed C locale.
 *
 * `localHostIdentity` adds a fallback for callers that only need "is this the same machine as
 * the one that wrote this record": without a platform id it derives `install-v1:<sha256>` from a
 * persisted random installation id (`machineIdentity.installation.ts`) and the hostname. That id
 * is per account home, not per host, so `machineIdentity` itself stays platform-only: per-host
 * callers (workspace-mode reservations, the state-dir lock, backend ownership and authority
 * records) keep their existing no-machine-id rules.
 *
 * @module machineIdentity
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

import { resolveOwnershipBaseDir } from "./backendOwnership.paths";
import { readOrCreateInstallationId } from "./machineIdentity.installation";

const PREFIX = "machine-v1:";
const INSTALLATION_PREFIX = "install-v1:";

export function parseIoregPlatformUuid(output: string): string | undefined {
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
  return match?.[1]?.trim() || undefined;
}

function darwinPlatformId(): string | undefined {
  try {
    return parseIoregPlatformUuid(
      execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      }),
    );
  } catch {
    return undefined;
  }
}

function linuxPlatformId(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(value)) return value.toLowerCase();
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

function platformId(): string | undefined {
  return process.platform === "darwin"
    ? darwinPlatformId()
    : process.platform === "linux"
      ? linuxPlatformId()
      : undefined;
}

let cached: string | null | undefined;

/** The digest every record carries; remote shell probes must reproduce it byte for byte. */
export function machineIdentityFromPlatformId(raw: string): string {
  return `${PREFIX}${createHash("sha256").update(`bigbud.machine-identity.v1\0${raw}`).digest("hex")}`;
}

/** App-scoped digest of the platform machine id, or `null` when the platform offers none. */
export function machineIdentity(): string | null {
  if (cached !== undefined) return cached;
  const raw = platformId();
  cached = raw ? machineIdentityFromPlatformId(raw) : null;
  return cached;
}

/** Fallback digest; its prefix keeps it disjoint from every `machine-v1:` identity. */
export function installationIdentityFrom(installationId: string, hostname: string): string {
  const digest = createHash("sha256")
    .update(`bigbud.installation-identity.v1\0${installationId}\0${hostname}`)
    .digest("hex");
  return `${INSTALLATION_PREFIX}${digest}`;
}

export type LocalHostIdentity =
  | { readonly source: "machine" | "installation"; readonly identity: string }
  | { readonly source: "none"; readonly identity: null; readonly reason: string };

export interface LocalHostIdentityOptions {
  readonly machine?: () => string | null;
  /** bigbud home holding `identity/installation-v1`; defaults to BIGBUD_HOME or ~/.bigbud. */
  readonly baseDir?: string;
  readonly hostname?: () => string;
}

/**
 * The platform machine identity when there is one (unchanged, no migration); otherwise the
 * installation fallback bound to the hostname, so two hosts sharing one home stay distinct.
 * A refused installation file yields `none` with a reason; it is never silently replaced.
 */
export function resolveLocalHostIdentity(
  options: LocalHostIdentityOptions = {},
): LocalHostIdentity {
  const machine = (options.machine ?? machineIdentity)();
  if (machine) return { source: "machine", identity: machine };
  const baseDir =
    options.baseDir ??
    resolveOwnershipBaseDir(process.env.BIGBUD_HOME?.trim() || process.env.T3CODE_HOME?.trim());
  const installation = readOrCreateInstallationId(baseDir);
  if (!installation.ok) {
    return {
      source: "none",
      identity: null,
      reason: `No platform machine id, and the bigbud installation id is unusable: ${installation.reason}.`,
    };
  }
  const hostname = (options.hostname ?? os.hostname)();
  return { source: "installation", identity: installationIdentityFrom(installation.id, hostname) };
}

let cachedLocal: LocalHostIdentity | undefined;

/** `resolveLocalHostIdentity()` for this process, computed once. */
export function localHostIdentity(): LocalHostIdentity {
  cachedLocal ??= resolveLocalHostIdentity();
  return cachedLocal;
}
