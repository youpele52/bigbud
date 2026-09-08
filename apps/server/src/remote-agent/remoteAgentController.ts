import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export interface RemoteAgentControllerIdentity {
  readonly id: string;
  readonly pid: number;
  readonly startedAt: string;
}

function processStartToken(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? value.replaceAll(/\s+/g, "_") : undefined;
  } catch {
    return undefined;
  }
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
    const startedAt = processStartToken(identity.pid);
    return startedAt === undefined || startedAt === identity.startedAt;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}
