import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, vi } from "vitest";

import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import {
  connectPickerProofAttachment,
  exchangePickerProofAttachmentHello,
} from "./sshOwnerPickerProof.attachment.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  encodeRequest,
  encodeStorageSnapshot,
  OWNER_MAJOR,
  type PickerProofRequest,
} from "./sshOwnerPickerProof.codec.ts";
import { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";

export async function writerEpoch(sql: SqlClient.SqlClient) {
  const [row] = await Effect.runPromise(sql<{ epoch: string }>`
    SELECT writer_epoch AS epoch FROM ssh_owner_writer WHERE singleton = 1
  `);
  if (!row) throw new Error("The isolated SQLite writer was not hydrated");
  return row.epoch;
}

export async function commitTransitionWithoutReply(options: {
  socketPath: string;
  capability: Uint8Array;
  profileBinding: Uint8Array;
  targetId: string;
  sql: SqlClient.SqlClient;
  action: "connect" | "disconnect";
}) {
  const disconnected = options.action === "disconnect";
  const pipe = await connectPickerProofAttachment(options.socketPath);
  try {
    const hydrate = await exchangePickerProofAttachmentHello(
      pipe,
      options.capability,
      options.profileBinding,
      OWNER_MAJOR,
    );
    expect(hydrate).toMatchObject({ kind: "storageHydrate", targetId: options.targetId });
    const snapshot = await hydratePickerProofTarget(options.sql, options.targetId);
    const hello = await pipe.exchange(encodeStorageSnapshot(options.targetId, snapshot));
    if (hello.kind !== "helloAccepted")
      throw new Error("Expected isolated owner to rebind storage");
    const id = randomBytes(16);
    const request: PickerProofRequest = {
      requestId: id,
      ownerEpoch: hello.ownerEpoch,
      generation: hello.generation,
      targetId: options.targetId,
      operation: { kind: options.action },
    };
    const grant = await pipe.exchange(encodeRequest(request));
    if (grant.kind !== "grantReply" || grant.error !== 0)
      throw new Error(`Expected ${options.action} grant`);
    const dispatch = await pipe.exchange(encodeRequest(request, grant.grant));
    expect(dispatch).toMatchObject({
      kind: "storageTransition",
      disconnected,
      targetId: options.targetId,
      writerEpoch: snapshot.writerEpoch,
      expectedSeq: snapshot.seq,
    });
    const receipt = await Effect.runPromise(
      applySshOwnerTransition(options.sql, {
        writerEpoch: snapshot.writerEpoch,
        expectedSeq: snapshot.seq,
        targetId: options.targetId,
        requestId: id.toString("hex"),
        desiredState: disconnected ? "disconnected" : "connected",
      }),
    );
    expect(receipt).toEqual({ kind: "committed", seq: snapshot.seq + 1 });
    // Intentionally never send ProofStorageResult. The owner sees EOF, not success.
    return { writerEpoch: snapshot.writerEpoch, seq: snapshot.seq + 1 };
  } finally {
    await pipe.close();
  }
}

export function isFixtureChildAlive(pid: number) {
  try {
    // Signal 0 only checks the live PID reported by our private fixture owner.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function openReadyTerminal(owner: PickerProofOwner) {
  const terminal = await owner.openProofTerminal();
  await vi.waitFor(
    async () => {
      const status = await owner.proofTerminalStatus(terminal.lease);
      expect(status).toMatchObject({ pid: terminal.pid, live: true });
      expect(Buffer.from(status.sample).toString()).toContain("BIGBUD_SSH_OWNER_PROOF_PTY_READY");
    },
    { timeout: 5_000 },
  );
  return terminal;
}

/** Durable disconnect flag (with its first timestamp) and the transition receipt row. */
export async function durableTransition(sql: SqlClient.SqlClient, targetId: string) {
  const flags = await Effect.runPromise(sql<{ disconnectedAt: number }>`
    SELECT disconnected_at AS disconnectedAt FROM remote_execution_target_disconnects
    WHERE target_id = ${targetId}
  `);
  const receipts = await Effect.runPromise(sql<{ seq: number; requestId: string }>`
    SELECT seq, last_request_id AS requestId FROM ssh_target_transition
    WHERE target_id = ${targetId}
  `);
  return { disconnectedAt: flags[0]?.disconnectedAt, receipt: receipts[0] };
}

/**
 * Deliver a delayed Connect carrying an earlier owner generation to the live owner. The owner
 * must refuse it before issuing a grant or asking storage for a transition.
 */
export async function sendStaleConnect(options: {
  socketPath: string;
  capability: Uint8Array;
  profileBinding: Uint8Array;
  targetId: string;
  sql: SqlClient.SqlClient;
  staleGeneration?: Uint8Array;
}) {
  const pipe = await connectPickerProofAttachment(options.socketPath);
  try {
    await exchangePickerProofAttachmentHello(
      pipe,
      options.capability,
      options.profileBinding,
      OWNER_MAJOR,
    );
    const snapshot = await hydratePickerProofTarget(options.sql, options.targetId);
    const hello = await pipe.exchange(encodeStorageSnapshot(options.targetId, snapshot));
    if (hello.kind !== "helloAccepted") throw new Error("Expected the owner to rebind storage");
    if (!options.staleGeneration) return Uint8Array.from(hello.generation);
    const request: PickerProofRequest = {
      requestId: randomBytes(16),
      ownerEpoch: hello.ownerEpoch,
      generation: options.staleGeneration,
      targetId: options.targetId,
      operation: { kind: "connect" },
    };
    const grant = await pipe.exchange(encodeRequest(request));
    expect(grant).toMatchObject({ kind: "grantReply" });
    if (grant.kind !== "grantReply") throw new Error("Expected a grant reply");
    expect(grant.error).not.toBe(0);
    return Uint8Array.from(hello.generation);
  } finally {
    await pipe.close();
  }
}
