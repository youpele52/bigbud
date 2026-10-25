import { requireContract } from "./errors";

export type AcceptPartition = "public" | "root" | "cleanup";
export type ConnectionPartition =
  | "rootControl"
  | "rootStatus"
  | "cleanupControl"
  | "cleanupStatus"
  | "backend"
  | "host"
  | "mainTelemetry"
  | "hostTelemetry"
  | "backendBulk"
  | "hostBulk";
const acceptCaps = { public: 32, root: 4, cleanup: 4 } as const;
const connectionCaps: Record<ConnectionPartition, number> = {
  rootControl: 2,
  rootStatus: 2,
  cleanupControl: 2,
  cleanupStatus: 2,
  backend: 2,
  host: 2,
  mainTelemetry: 2,
  hostTelemetry: 2,
  backendBulk: 24,
  hostBulk: 24,
};
interface Connection {
  source: AcceptPartition;
  acceptedAt: number;
  destination?: ConnectionPartition;
  parent?: number;
  promoted: boolean;
  workPending: boolean;
  closing: boolean;
  generation?: string;
}

/** Bounded partition accounting, not a listener, executor or OS-memory guarantee. */
export class OwnerConnectionQuotaModel {
  private next = 0;
  private connections = new Map<number, Connection>();
  accept(source: AcceptPartition, now: number): number {
    requireContract(
      Number.isSafeInteger(now) && now >= 0 && this.countSource(source) < acceptCaps[source],
      "CAPACITY",
    );
    requireContract(this.next < Number.MAX_SAFE_INTEGER, "COUNTER_EXHAUSTED");
    const id = ++this.next;
    this.connections.set(id, {
      source,
      acceptedAt: now,
      promoted: false,
      workPending: false,
      closing: false,
    });
    return id;
  }
  reserve(
    id: number,
    destination: ConnectionPartition,
    ownerVerifiedRoleLookup: boolean,
    parent?: number,
    generation?: string,
  ) {
    const connection = this.connections.get(id);
    const bulk = destination === "backendBulk" || destination === "hostBulk";
    requireContract(
      bulk ? parent !== undefined && parent !== id : parent === undefined,
      "ROLE_DENIED",
    );
    if (bulk || destination === "backend" || destination === "host")
      requireContract(
        typeof generation === "string" &&
          /^[1-9][0-9]{0,19}$/.test(generation) &&
          BigInt(generation) <= 18446744073709551615n,
        "ROLE_DENIED",
      );
    requireContract(
      connection && !connection.closing && !connection.destination && ownerVerifiedRoleLookup,
      "ROLE_DENIED",
    );
    const root = destination.startsWith("root") || destination === "mainTelemetry";
    const cleanup = destination.startsWith("cleanup");
    requireContract(
      connection.source === (root ? "root" : cleanup ? "cleanup" : "public"),
      "ROLE_DENIED",
    );
    requireContract(this.countDestination(destination) < connectionCaps[destination], "CAPACITY");
    if (bulk) {
      const authority = parent === undefined ? undefined : this.connections.get(parent);
      requireContract(
        authority?.promoted &&
          !authority.closing &&
          authority.generation === generation &&
          authority.destination === (destination === "backendBulk" ? "backend" : "host"),
        "ROLE_DENIED",
      );
      requireContract(
        [...this.connections.values()].filter((c) => c.parent === parent).length < 2,
        "CAPACITY",
      );
    }
    connection.destination = destination;
    if (parent !== undefined) connection.parent = parent;
    if (generation !== undefined) connection.generation = generation;
  }
  promote(id: number, now: number) {
    const connection = this.connections.get(id);
    requireContract(
      connection &&
        !connection.closing &&
        !connection.promoted &&
        connection.destination &&
        Number.isSafeInteger(now) &&
        now >= connection.acceptedAt &&
        now - connection.acceptedAt < 5000,
      "AUTH_EXPIRED",
    );
    connection.promoted = true;
  }
  expire(now: number) {
    requireContract(Number.isSafeInteger(now) && now >= 0, "CLOCK_INVALID");
    for (const [id, c] of this.connections)
      if (!c.promoted && now >= c.acceptedAt + 5000) this.close(id);
  }
  close(id: number) {
    const pending = [id];
    const visited = new Set<number>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const [child, c] of this.connections) if (c.parent === current) pending.push(child);
      const connection = this.connections.get(current);
      if (connection?.workPending) connection.closing = true;
      else this.connections.delete(current);
    }
  }
  beginWork(id: number) {
    const connection = this.connections.get(id);
    requireContract(
      connection && !connection.closing && !connection.workPending,
      "CONNECTION_UNAVAILABLE",
    );
    connection.workPending = true;
  }
  settleWork(id: number) {
    const connection = this.connections.get(id);
    requireContract(connection?.workPending, "CONNECTION_UNAVAILABLE");
    connection.workPending = false;
    if (connection.closing) this.connections.delete(id);
  }
  countSource(source: AcceptPartition) {
    return [...this.connections.values()].filter((c) => !c.promoted && c.source === source).length;
  }
  countDestination(destination: ConnectionPartition) {
    return [...this.connections.values()].filter((c) => c.destination === destination).length;
  }
  snapshot() {
    return {
      physical: this.connections.size,
      promotionOrAuthenticated: [...this.connections.values()].filter((c) => c.destination).length,
      preAuth: [...this.connections.values()].filter((c) => !c.promoted).length,
    };
  }
}
