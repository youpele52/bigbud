import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { V2RecoveryHost } from "./RebootRecovery.host.ts";

const exec = promisify(execFile);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Preserve the v1 macOS host digest and signed checkpoint shape exactly. */
export function decodeV2DarwinRecoveryHost(
  platform: string,
  session: string,
  boot: string,
): V2RecoveryHost {
  const uuid = /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/.exec(platform)?.[1];
  const bootSession = session.trim();
  const time = /^\{ sec = (\d+), usec = (\d+) \}/.exec(boot);
  const bootSeconds = Number(time?.[1]),
    bootMicroseconds = Number(time?.[2]);
  if (
    !uuid ||
    !uuidPattern.test(uuid) ||
    !uuidPattern.test(bootSession) ||
    !Number.isSafeInteger(bootSeconds) ||
    bootSeconds <= 0 ||
    !Number.isSafeInteger(bootMicroseconds) ||
    bootMicroseconds < 0 ||
    bootMicroseconds >= 1000000
  )
    throw new Error("V2 authoritative host/boot identity unavailable.");
  return Object.freeze({
    host: createHash("sha256")
      .update(`bigbud.recovery.host.v1:${uuid.toLowerCase()}`)
      .digest("hex"),
    bootSession: bootSession.toLowerCase(),
    bootSeconds,
    bootMicroseconds,
  });
}

export async function readV2DarwinRecoveryHost(): Promise<V2RecoveryHost> {
  const options = { timeout: 3000, maxBuffer: 32768, encoding: "utf8" as const };
  const [platform, session, boot] = await Promise.all([
    exec("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], options),
    exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options),
    exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], options),
  ]);
  return decodeV2DarwinRecoveryHost(platform.stdout, session.stdout, boot.stdout);
}
