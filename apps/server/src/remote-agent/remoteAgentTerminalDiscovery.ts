import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import type { RemoteAgentPtyInventory } from "./remoteAgentPtyInventory.ts";
import type { RemoteAgentPtyInventoryEntry } from "./remoteAgentProtocol.pty.ts";

export interface DiscoveredRemoteTerminal {
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId: string;
  readonly resourceId: string;
  readonly generation: string;
  readonly epoch: string;
  readonly cwd?: string;
  readonly status: "running" | "stopped" | "unknown";
  readonly reason?: string;
  readonly pid?: number;
}

/** Local owner routes remain authoritative; live inventory only supplies observations. */
export class RemoteAgentTerminalDiscovery {
  constructor(
    private readonly owners: Pick<RemoteAgentOwnerStore, "listTerminalOwners">,
    private readonly inventory: Pick<RemoteAgentPtyInventory, "list">,
  ) {}

  async list(target: string, after = "", signal?: AbortSignal) {
    if (!this.owners.listTerminalOwners)
      throw new Error("Terminal owner discovery is unavailable.");
    const page = await this.owners.listTerminalOwners(target, after, 100);
    if (page.owners.length > 100) throw new Error("Terminal owner page exceeds its bound.");
    const observations = new Map<string, ReadonlyArray<RemoteAgentPtyInventoryEntry> | string>();
    const sessions: DiscoveredRemoteTerminal[] = [];
    for (const owner of page.owners) {
      signal?.throwIfAborted();
      const identity = terminalIdentity(owner);
      if (!identity) continue; // Non-application PTYs cannot be adopted as a chat terminal.
      const cwd = owner.terminalCwd ?? owner.shellLaunch?.cwd;
      const base = {
        ...identity,
        executionTargetId: target,
        resourceId: owner.resourceId,
        generation: owner.runtime.generation,
        epoch: owner.epoch,
        ...(cwd === undefined ? {} : { cwd }),
      };
      if (owner.target !== target) throw new Error("Terminal owner target mismatch.");
      if (owner.state === "terminal") {
        sessions.push({ ...base, status: "stopped" });
        continue;
      }
      const key = JSON.stringify([owner.runtime, owner.epoch, owner.connectionId]);
      let observed = observations.get(key);
      if (!observed) {
        if (observations.size >= 8) observed = "runtime-query-limit";
        else {
          try {
            observed = await this.inventory.list(
              target,
              {
                runtime: owner.runtime,
                expectedEpoch: owner.epoch,
                connectionId: owner.connectionId,
              },
              signal,
            );
          } catch {
            signal?.throwIfAborted();
            observed = "runtime-unavailable";
          }
          observations.set(key, observed);
        }
      }
      if (typeof observed === "string") {
        sessions.push({ ...base, status: "unknown", reason: observed });
        continue;
      }
      const remote = observed.find((entry) => entry.ptyId === owner.resourceId);
      if (!remote || Buffer.from(remote.requestDigest).toString("hex") !== owner.digest) {
        sessions.push({
          ...base,
          status: "unknown",
          reason: remote ? "identity-conflict" : "resource-not-observed",
        });
      } else if (remote.verifiedExit) {
        sessions.push({ ...base, status: "stopped" });
      } else if (remote.state === "running" && remote.pid > 0) {
        sessions.push({ ...base, status: "running", pid: remote.pid });
      } else {
        sessions.push({ ...base, status: "unknown", reason: "exit-not-confirmed" });
      }
    }
    return { sessions, nextCursor: page.nextCursor };
  }
}

function terminalIdentity(
  owner: RemoteAgentOwner,
): { threadId: string; terminalId: string } | undefined {
  if (!owner.ownerKey.startsWith("terminal:")) return undefined;
  try {
    const value: unknown = JSON.parse(owner.ownerKey.slice("terminal:".length));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 128)
    )
      return undefined;
    return { threadId: value[0] as string, terminalId: value[1] as string };
  } catch {
    return undefined;
  }
}
