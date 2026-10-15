import { createHash } from "node:crypto";
import { v2WindowsInspector } from "./SharedService.windows.ts";
import { requireV2WindowsInspectionFeature } from "./SharedService.windows.identity.ts";
import type { V2RecoveryHost } from "./RebootRecovery.host.ts";

/** The opaque session value carries the kernel BootId, not a generated GUID or timestamp. */
export function v2WindowsBootSequence(session: string): number | undefined {
  if (!session.startsWith("windows-kernel:")) return undefined;
  const value = session.slice("windows-kernel:".length);
  const sequence = Number(value);
  if (!/^(0|[1-9]\d{0,9})$/.test(value) || sequence > 0xffffffff)
    throw new Error("V2 Windows kernel boot generation rejected.");
  return sequence;
}

/** Decode only the native helper's bounded versioned boot response, never caller/environment overrides. */
export function decodeV2WindowsRecoveryHost(fields: readonly string[]): V2RecoveryHost {
  const [machine, counter, seconds, micros] = fields;
  if (
    fields.length !== 4 ||
    !machine ||
    !/^[a-f0-9]{32}$/.test(machine) ||
    /^0+$/.test(machine) ||
    /^f+$/.test(machine) ||
    counter === undefined ||
    !seconds ||
    !/^[1-9]\d{0,12}$/.test(seconds) ||
    micros === undefined ||
    !/^(0|[1-9]\d{0,5})$/.test(micros)
  )
    throw new Error("V2 Windows native host/boot evidence rejected.");
  const bootSession = `windows-kernel:${counter}`;
  v2WindowsBootSequence(bootSession);
  return Object.freeze({
    host: createHash("sha256").update(`bigbud.recovery.host.windows.v1:${machine}`).digest("hex"),
    bootSession,
    bootSeconds: Number(seconds),
    bootMicroseconds: Number(micros),
  });
}

export async function readV2WindowsRecoveryHost(): Promise<V2RecoveryHost> {
  await requireV2WindowsInspectionFeature("boot=1");
  return decodeV2WindowsRecoveryHost(await v2WindowsInspector.request("BOOT\t1"));
}
