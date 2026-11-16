import type { RunSshCommandInput } from "../ssh/sshProcess";
import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify";
import {
  readRemoteAgentRegistryReadOnly,
  summarizeRemoteAgentRegistry,
} from "./remoteAgentReadOnlyStatus";
import { readRemoteAgentInventoryWithoutStart } from "./remoteAgentReadOnlyInventory";

/** Status/doctor observations never install, start, attach, prune or signal a supervisor. */
export async function remoteAgentReadOnlyDiagnostics(
  target: string,
  run?: (input: RunSshCommandInput) => Promise<unknown>,
  timeoutMs = 15_000,
  inventory = readRemoteAgentInventoryWithoutStart,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const registry = await readRemoteAgentRegistryReadOnly(target, run, timeoutMs);
  const summary = summarizeRemoteAgentRegistry(registry);
  if (!registry)
    return {
      ...summary,
      terminals: { status: "unavailable", running: null, unknown: null, runtimes: [] },
    };
  const candidates = registry.builds.filter((build) => build.binary === "present");
  const runtimes: Array<{
    generation: string;
    version: string;
    status: "observed" | "unknown";
    running: number | null;
    unknown: number | null;
    stopped: number | null;
    pinnedOwners: number;
    reason?: string;
  }> = [];
  for (const build of candidates.slice(0, 8)) {
    const base = {
      generation: build.runtime.generation,
      version: build.runtime.version,
      pinnedOwners: registry.pins.filter((pin) => pin.buildId === build.id).length,
    };
    const launch = registry.launches.findLast(
      (launch) => launch.buildId === build.id && launch.phase === "ready" && launch.epoch,
    );
    if (!launch || signal.aborted) {
      runtimes.push({
        ...base,
        status: "unknown",
        running: null,
        unknown: null,
        stopped: null,
        reason: launch ? "observation-deadline" : "no-recorded-live-epoch",
      });
      continue;
    }
    try {
      const entries = await inventory(
        target,
        { runtime: build.runtime, expectedEpoch: launch.epoch },
        signal,
      );
      runtimes.push({
        ...base,
        status: "observed",
        running: entries.filter(
          (entry) => entry.state === "running" && entry.pid > 0 && !entry.verifiedExit,
        ).length,
        unknown: entries.filter(
          (entry) => !entry.verifiedExit && !(entry.state === "running" && entry.pid > 0),
        ).length,
        stopped: entries.filter((entry) => entry.verifiedExit).length,
      });
    } catch (cause) {
      if (classifyRemoteAgentFailure(cause)?.kind === "ssh-host-trust") throw cause;
      runtimes.push({
        ...base,
        status: "unknown",
        running: null,
        unknown: null,
        stopped: null,
        reason: "inventory-unavailable",
      });
    }
  }
  const complete =
    candidates.length <= 8 &&
    runtimes.length > 0 &&
    runtimes.every((runtime) => runtime.status === "observed");
  return {
    ...summary,
    note: "Registry and bounded PTY inventory observations only. No supervisor is started. Pinned owners are retention references, not a live provider-work count; unavailable inventory is unknown.",
    terminals: {
      status: complete ? "observed" : "partial-or-unknown",
      running: complete ? runtimes.reduce((total, runtime) => total + runtime.running!, 0) : null,
      unknown: complete ? runtimes.reduce((total, runtime) => total + runtime.unknown!, 0) : null,
      unqueriedRuntimes: Math.max(0, candidates.length - 8),
      runtimes,
    },
  };
}
