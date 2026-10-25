import { randomUUID } from "node:crypto";

import { compareProcessStartToken, processStartToken } from "../utils/processStartToken.ts";

export interface RemoteAgentControllerIdentity {
  readonly id: string;
  readonly pid: number;
  readonly startedAt: string;
}

const controller: RemoteAgentControllerIdentity = {
  id: `controller:${process.pid}:${randomUUID()}`,
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
  try {
    process.kill(identity.pid, 0);
    // Only comparable tokens that differ prove PID reuse; legacy or unobtainable ones fail closed.
    return (
      compareProcessStartToken(identity.startedAt, processStartToken(identity.pid)) !== "different"
    );
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}
