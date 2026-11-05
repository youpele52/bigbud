import { runProcess } from "../utils/processRunner.ts";
import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import { validSshMonitorTarget } from "./sshMonitor.target.ts";

interface Connection {
  owners: Map<string, object>;
  lastSuccess: number;
  probe: Promise<boolean> | undefined;
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

/** Coalesced read-only health checks across tabs; a failed probe revokes all caller leases. */
export async function isConnectedSshMonitorTarget(
  target: string,
  callerId: string,
): Promise<boolean> {
  const connection = connections.get(target);
  const lease = connection?.owners.get(callerId);
  if (!connection || !lease) return false;
  if (Date.now() - connection.lastSuccess < CHECK_INTERVAL_MS) return true;
  if (connection.probe)
    return connection.probe.then(
      (connected) => connected && sshMonitorLease(target, callerId) === lease,
    );
  const startedAt = Date.now();
  const probe = (async () => {
    try {
      const invocation = remoteReadOnlyInvocation(target, "sh -c 'true'");
      await runProcess(invocation.command, invocation.args, {
        shell: false,
        timeoutMs: 3_000,
        settleOnTimeout: true,
        maxBufferBytes: 4_096,
        outputMode: "error",
      });
      if (connections.get(target) !== connection) return false;
      // Health belongs to the host; admission still belongs to each caller lease.
      connection.lastSuccess = Date.now();
      return true;
    } catch {
      if (connections.get(target) !== connection) return false;
      // A successful monitor sample after this probe began supersedes its failed result.
      if (connection.lastSuccess > startedAt) return true;
      forgetSshMonitorTarget(target);
      return false;
    }
  })();
  connection.probe = probe;
  try {
    return (await probe) && sshMonitorLease(target, callerId) === lease;
  } finally {
    if (connections.get(target) === connection) connection.probe = undefined;
  }
}
