import { createHash, randomUUID } from "node:crypto";

import { readlinkSync } from "node:fs";
import { localHostIdentity } from "../utils/machineIdentity.ts";

import { compareProcessStartToken, processStartToken } from "../utils/processStartToken.ts";

export interface RemoteAgentControllerIdentity {
  readonly id: string;
  readonly pid: number;
  readonly startedAt: string;
}

// PID evidence is meaningful only on the same machine and in the same PID namespace. Without a
// platform machine id the persisted installation identity stands in (`install-v1:`, bound to the
// hostname), so a restarted backend in the same container still recognises its dead predecessor.
function localControllerScope(): { readonly scope?: string; readonly issue?: string } {
  const host = localHostIdentity();
  if (host.identity === null) return { issue: host.reason };
  try {
    const namespace =
      process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : process.platform;
    return { scope: createHash("sha256").update(`${host.identity}:${namespace}`).digest("hex") };
  } catch (cause) {
    return { issue: `The PID namespace is unreadable: ${String(cause)}` };
  }
}
const { scope, issue: scopeIssue } = localControllerScope();
const controller: RemoteAgentControllerIdentity = {
  id: `controller-v2:${scope ?? "unknown"}:${process.pid}:${randomUUID()}`,
  pid: process.pid,
  startedAt: processStartToken(process.pid) ?? `pid:${process.pid}`,
};

export function currentRemoteAgentController(): RemoteAgentControllerIdentity {
  return controller;
}

/** Why this controller cannot prove any earlier controller dead, if it cannot. */
export function remoteAgentControllerScopeIssue(): string | undefined {
  return scopeIssue;
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
