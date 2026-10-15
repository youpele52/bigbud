/**
 * Stable machine identity for durable ownership records (backend lock, thread-tools markers).
 *
 * Hostnames are not stable: macOS renames the host with the network (`name.local` vs
 * `name.fritz.box`). The platform id survives that: macOS `IOPlatformUUID` (ioreg), Linux
 * `/etc/machine-id` or `/var/lib/dbus/machine-id`. The raw id is never stored; records carry an
 * app-scoped SHA-256 digest of it. `null` when unavailable: callers then keep the hostname rule.
 * Computed once per process; the ioreg call runs under a fixed C locale.
 *
 * @module machineIdentity
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PREFIX = "machine-v1:";

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

let cached: string | null | undefined;

/** App-scoped digest of the platform machine id, or `null` when the platform offers none. */
export function machineIdentity(): string | null {
  if (cached !== undefined) return cached;
  const raw =
    process.platform === "darwin"
      ? darwinPlatformId()
      : process.platform === "linux"
        ? linuxPlatformId()
        : undefined;
  cached = raw
    ? `${PREFIX}${createHash("sha256").update(`bigbud.machine-identity.v1\0${raw}`).digest("hex")}`
    : null;
  return cached;
}
