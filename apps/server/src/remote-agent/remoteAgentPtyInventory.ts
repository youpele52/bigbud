import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type {
  RemoteAgentConnectionPool,
  RemoteAgentRuntimeBinding,
} from "./remoteAgentConnectionPool.ts";
import type {
  RemoteAgentPtyInventoryEntry,
  RemoteAgentPtyListResponse,
} from "./remoteAgentProtocol.pty.ts";

const CAPABILITY = "terminal.pty-inventory";
const MAX_SESSIONS = 64;
const MAX_PAGE_SIZE = 100;

/** A bounded observation of one pinned supervisor. Absence is never proof of exit. */
export class RemoteAgentPtyInventory {
  constructor(private readonly pool: Pick<RemoteAgentConnectionPool, "getBound">) {}

  private acquire(
    target: string,
    binding: RemoteAgentRuntimeBinding,
    signal: AbortSignal,
  ): Promise<RemoteAgentConnection> {
    // Cancel only this caller's wait. The pool owns and may share its pending acquisition.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", abort);
        abort();
        return;
      }
      void this.pool.getBound(target, binding, [CAPABILITY]).then(
        (connection) => {
          signal.removeEventListener("abort", abort);
          resolve(connection);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  }

  async list(
    target: string,
    binding: RemoteAgentRuntimeBinding,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<RemoteAgentPtyInventoryEntry>> {
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]);
    boundedSignal.throwIfAborted();
    // getBound verifies the runtime/epoch and refuses old agents before inventory dispatch.
    const connection = await this.acquire(target, binding, boundedSignal);
    boundedSignal.throwIfAborted();
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries: RemoteAgentPtyInventoryEntry[] = [];
      let afterPtyId = "";
      let snapshotId = "";
      for (let page = 0; page < MAX_SESSIONS + 1; page++) {
        const requestId = randomUUID();
        const response = await connection.request(
          {
            type: "ptyListRequest",
            value: {
              requestId,
              expectedEpoch: binding.expectedEpoch,
              afterPtyId,
              limit: MAX_PAGE_SIZE,
              snapshotId,
            },
          },
          (frame) => frame.type === "ptyListResponse" && frame.value.requestId === requestId,
          boundedSignal,
        );
        if (response.type !== "ptyListResponse" || response.value.requestId !== requestId)
          throw new Error("Invalid terminal inventory response.");
        const value = response.value;
        if (value.agentEpoch !== binding.expectedEpoch)
          throw new Error("Terminal inventory belongs to a different supervisor epoch.");
        if (!value.accepted) {
          if (value.errorCode === "PTY_INVENTORY_CHANGED") break;
          throw new Error(`Terminal inventory unavailable: ${value.errorCode.slice(0, 100)}`);
        }
        validatePage(value, afterPtyId, snapshotId);
        entries.push(...value.entries);
        if (entries.length > MAX_SESSIONS)
          throw new Error("Terminal inventory exceeds its session bound.");
        if (!value.nextAfterPtyId) return entries;
        afterPtyId = value.nextAfterPtyId;
        snapshotId = value.snapshotId;
      }
    }
    throw new Error("Terminal inventory changed during discovery. Retry discovery.");
  }
}

function validatePage(value: RemoteAgentPtyListResponse, after: string, snapshot: string): void {
  if (
    !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
    (snapshot && value.snapshotId !== snapshot) ||
    value.entries.length > MAX_PAGE_SIZE ||
    value.errorCode !== ""
  )
    throw new Error("Invalid terminal inventory page.");
  let previous = after;
  for (const entry of value.entries) {
    if (
      !/^[\x20-\x7e]{1,256}$/.test(entry.ptyId) ||
      entry.ptyId <= previous ||
      entry.requestDigest.length > 64 ||
      !["running", "exited", "closed", "outcome-unknown"].includes(entry.state) ||
      entry.launchStatus !== "unconfirmed" ||
      ![entry.pid, entry.nextSequence, entry.firstRetainedSequence].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      entry.firstRetainedSequence > entry.nextSequence ||
      (entry.verifiedExit && !["exited", "closed"].includes(entry.state))
    )
      throw new Error("Invalid terminal inventory entry.");
    previous = entry.ptyId;
  }
  if (value.nextAfterPtyId && (value.entries.length === 0 || value.nextAfterPtyId !== previous))
    throw new Error("Terminal inventory cursor did not advance.");
}
