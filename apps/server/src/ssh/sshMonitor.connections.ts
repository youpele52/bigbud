import { runProcess } from "../utils/processRunner.ts";
import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import type { SshMonitorHealthOwner } from "./sshMonitor.healthOwner.ts";
import { validSshMonitorTarget } from "./sshMonitor.target.ts";
import { isSshOwnerSelected } from "./sshOwnerSelection.ts";

interface HealthProbe {
  readonly abort: AbortController;
  readonly readers: Set<(healthy: boolean) => void>;
}

interface HealthCheck {
  lastSuccess: number;
  probe: HealthProbe | undefined;
}

/** A cancelled reader detaches immediately without cancelling peers on the same probe. */
function readProbe(check: HealthCheck, probe: HealthProbe, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (healthy: boolean) => {
      signal?.removeEventListener("abort", cancel);
      probe.readers.delete(finish);
      resolve(healthy);
    };
    const cancel = () => {
      finish(false);
      if (check.probe === probe && probe.readers.size === 0) {
        check.probe = undefined;
        probe.abort.abort();
      }
    };
    probe.readers.add(finish);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

interface Connection extends HealthCheck {
  owners: Map<string, object>;
  ownerChecks?: WeakMap<SshMonitorHealthOwner, HealthCheck>;
}
const connections = new Map<string, Connection>();
const CHECK_INTERVAL_MS = 5_000;

/** A route instance disambiguates numeric RPC ids reused after an in-process restart. */
export function sshMonitorCallerId(
  instanceId: string | undefined,
  clientId: number | undefined,
): string | null {
  return instanceId && clientId !== undefined && Number.isSafeInteger(clientId) && clientId >= 0
    ? `${instanceId}:${clientId}`
    : null;
}

/** Only server-assigned RPC connection ids can admit a verified SSH target. */
export function recordVerifiedSshMonitorTarget(target: string, callerId: string | null): void {
  if (!validSshMonitorTarget(target) || !callerId) return;
  let connection = connections.get(target);
  if (!connection) {
    connection = {
      owners: new Map(),
      lastSuccess: Date.now(),
      probe: undefined,
    };
    connections.set(target, connection);
  }
  connection.owners.set(callerId, {});
  connection.lastSuccess = Date.now();
}

export function forgetSshMonitorTarget(target: string): void {
  connections.delete(target);
}

/** A closed socket loses only its own admission; other sockets retain shared host health. */
export function forgetSshMonitorCaller(callerId: string | null): void {
  if (!callerId) return;
  for (const [target, connection] of connections) {
    connection.owners.delete(callerId);
    if (connection.owners.size === 0) connections.delete(target);
  }
}

/** Server shutdown also removes any close events still queued when its protocol stops. */
export function forgetSshMonitorInstance(instanceId: string): void {
  const prefix = `${instanceId}:`;
  for (const [target, connection] of connections) {
    for (const callerId of connection.owners.keys())
      if (callerId.startsWith(prefix)) connection.owners.delete(callerId);
    if (connection.owners.size === 0) connections.delete(target);
  }
}

/** The returned object is an opaque admission generation, invalidated on revoke or reverify. */
export function sshMonitorLease(target: string, callerId: string): object | null {
  return connections.get(target)?.owners.get(callerId) ?? null;
}

/** A failed reachability check makes an admitted target unavailable. */
export function isHealthySshMonitorTarget(
  target: string,
  callerId: string,
  lease: object,
): boolean {
  const connection = connections.get(target);
  return connection?.owners.get(callerId) === lease;
}

export function recordSshMonitorSample(
  target: string,
  sampledAtMs: number,
  callerId: string,
  lease: object,
): void {
  const connection = connections.get(target);
  if (!connection || connection.owners.get(callerId) !== lease || !Number.isFinite(sampledAtMs))
    return;
  connection.lastSuccess = Math.max(connection.lastSuccess, sampledAtMs);
}

async function sampleLegacyHealth(target: string): Promise<"reachable" | "unreachable"> {
  try {
    const invocation = remoteReadOnlyInvocation(target, "sh -c 'true'");
    await runProcess(invocation.command, invocation.args, {
      shell: false,
      timeoutMs: 3_000,
      settleOnTimeout: true,
      maxBufferBytes: 4_096,
      outputMode: "error",
    });
    return "reachable";
  } catch {
    return "unreachable";
  }
}

/** Coalesced health checks across tabs; only confirmed failure can revoke caller leases. */
export async function isConnectedSshMonitorTarget(
  target: string,
  callerId: string,
  owner?: SshMonitorHealthOwner,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const connection = connections.get(target);
  const lease = connection?.owners.get(callerId);
  if (!connection || !lease || (!owner && isSshOwnerSelected())) return false;

  let check: HealthCheck = connection;
  if (owner) {
    // A selected owner must establish its own freshness, independent of the legacy path.
    const ownerChecks = (connection.ownerChecks ??= new WeakMap());
    const existing = ownerChecks.get(owner);
    check = existing ?? { lastSuccess: -Infinity, probe: undefined };
    if (!existing) ownerChecks.set(owner, check);
  }
  if (Date.now() - check.lastSuccess < CHECK_INTERVAL_MS) return true;
  let probe = check.probe;
  if (!probe) {
    const active: HealthProbe = { abort: new AbortController(), readers: new Set() };
    check.probe = probe = active;
    const startedAt = Date.now();
    const run = async () => {
      try {
        const health = owner
          ? await owner.sampleHealth(target, active.abort.signal)
          : await sampleLegacyHealth(target);
        if (active.abort.signal.aborted || connections.get(target) !== connection) return false;
        if (health === "reachable") {
          check.lastSuccess = Date.now();
          return true;
        }
        if (health !== "unreachable") return false;
      } catch {
        // An unavailable owner is not evidence that the transport died.
        return false;
      }
      // A successful monitor sample or verification after the probe began supersedes its failure.
      if (connection.lastSuccess > startedAt) return true;
      forgetSshMonitorTarget(target);
      return false;
    };
    void run().then((healthy) => {
      if (check.probe === active) check.probe = undefined;
      for (const finish of active.readers) finish(healthy);
    });
  }
  return (
    (await readProbe(check, probe, owner ? signal : undefined)) &&
    !signal?.aborted &&
    sshMonitorLease(target, callerId) === lease
  );
}
