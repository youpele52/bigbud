import { createHash, randomUUID } from "node:crypto";

import { readlinkSync } from "node:fs";
import { machineIdentity } from "../utils/machineIdentity.ts";

import { compareProcessStartToken, processStartToken } from "../utils/processStartToken.ts";

export interface RemoteAgentControllerIdentity {
  readonly id: string;
  readonly pid: number;
  readonly startedAt: string;
}

// PID evidence is meaningful only on the same machine and in the same PID namespace.
function localControllerScope(): string | undefined {
  const machine = machineIdentity();
  if (!machine) return undefined;
  try {
    const namespace =
      process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : process.platform;
    return createHash("sha256").update(`${machine}:${namespace}`).digest("hex");
  } catch {
    return undefined;
  }
}
const scope = localControllerScope();
const controller: RemoteAgentControllerIdentity = {
  id: `controller-v2:${scope ?? "unknown"}:${process.pid}:${randomUUID()}`,
  pid: process.pid,
  startedAt: processStartToken(process.pid) ?? `pid:${process.pid}`,
};

export function currentRemoteAgentController(): RemoteAgentControllerIdentity {
  return controller;
}

/** A prepared reservation is reclaimable only after its owning process is proven absent. */
export async function isRemoteAgentControllerAlive(
  identity: Pick<RemoteAgentControllerIdentity, "id" | "pid" | "startedAt">,
): Promise<boolean> {
  if (identity.id === controller.id) return true;
  const match = /^controller-v2:([a-f0-9]{64}):([1-9][0-9]*):[a-f0-9-]{36}$/.exec(identity.id);
  if (!scope || !match || match[1] !== scope || Number(match[2]) !== identity.pid) return true;
  try {
    process.kill(identity.pid, 0);
    // Only comparable tokens that differ prove PID reuse; legacy or unobtainable ones fail closed.
    return (
      compareProcessStartToken(identity.startedAt, processStartToken(identity.pid)) !== "different"
    );
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
  }
}
