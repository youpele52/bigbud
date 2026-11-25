import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import {
  decodeOwnerError,
  encodeRequest,
  encodeStorageResult,
  encodeStorageSnapshot,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  type PickerProofOperation,
  type ProofTargetDescriptorInput,
} from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid as invalidProtocol } from "./sshOwnerPickerProof.codec.wire.ts";
import { verifyWorkspaceGitResult } from "./sshOwnerPickerProof.codec.git.ts";
import { verifyProofTerminalReplay } from "./sshOwnerPickerProof.codec.terminal.ts";
import { verifyWorkspaceFile } from "./sshOwnerPickerProof.codec.workspaceFile.ts";
import type { PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import { expectedOutcome } from "./sshOwnerPickerProof.client.expectedOutcome.ts";
import { proofRequestPolicy } from "./sshOwnerPickerProof.client.requestPolicy.ts";
import { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";

/**
 * One request/reply exchange for an exact target (W3.7).
 *
 * Extracted from the session so the wire loop, the per-target generation and the
 * durable transition handshake stay reviewable on their own. Every request
 * carries the target descriptor; the owner may ask for that target's durable
 * snapshot before dispatch, which this loop answers from the backend store.
 *
 * @module sshOwnerPickerProof.client.session.exchange
 */

export const EMPTY = new Uint8Array();
export const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(right);

/** Per-target admission state: descriptor, generation and durable snapshot. */
export interface TargetState {
  targetId: string;
  descriptor?: ProofTargetDescriptorInput;
  generation: Uint8Array;
  snapshot?: Awaited<ReturnType<typeof hydratePickerProofTarget>>;
}

export interface SessionExchangeInput {
  readonly pipe: PickerProofPipe;
  readonly sql: SqlClient.SqlClient;
  readonly ownerEpoch: Uint8Array;
  readonly states: Map<string, TargetState>;
  /** The session cannot continue; it closes admission and the pipe. */
  readonly failClosed: () => void;
}

export function createSessionExchange(input: SessionExchangeInput) {
  const { pipe, sql, ownerEpoch, states, failClosed } = input;

  const stateFor = (state: TargetState | undefined) => {
    if (!state) throw new PickerProofOwnerError("invalidOperands");
    return state;
  };

  const requestFor = (state: TargetState, operation: PickerProofOperation) => {
    const generation = state.generation;
    return {
      requestId: randomBytes(16),
      ownerEpoch,
      generation,
      targetId: state.targetId,
      ...(state.descriptor === undefined ? {} : { target: { ...state.descriptor, generation } }),
      operation,
    };
  };

  /** Answers an owner-initiated hydration for any resolved target. */
  async function hydrate(
    reply: { targetId: string },
    timeout: Parameters<PickerProofPipe["exchange"]>[1],
  ) {
    let state = states.get(reply.targetId);
    if (!state) {
      state = { targetId: reply.targetId, generation: EMPTY };
      states.set(state.targetId, state);
    }
    if (state.snapshot === undefined) {
      try {
        state.snapshot = await hydratePickerProofTarget(sql, state.targetId);
      } catch {
        // An empty snapshot with the typed storage error closes admission there.
        return pipe.exchange(encodeStorageSnapshot(state.targetId, undefined), timeout);
      }
    }
    return pipe.exchange(encodeStorageSnapshot(state.targetId, state.snapshot), timeout);
  }

  async function run(
    state: TargetState | undefined,
    operation: PickerProofOperation,
    beforeDispatch?: (id: Uint8Array) => void,
  ) {
    const target = stateFor(state);
    const request = requestFor(target, operation);
    const { requestId } = request;
    const expected =
      operation.kind === "connect"
        ? "connected"
        : operation.kind === "disconnect"
          ? "disconnected"
          : undefined;
    const { proofMutation, grantTimeout, replyTimeout } = proofRequestPolicy(operation);
    let sent = false;
    let preparing = false;
    let committed = false;
    let storageFailed = false;
    let outcome: Outcome;
    try {
      const granted = await pipe.exchange(encodeRequest(request), grantTimeout);
      if (granted.kind !== "grantReply" || !sameBytes(granted.requestId, requestId))
        return invalidProtocol();
      if (granted.error) {
        outcome = { kind: "error", code: decodeOwnerError(granted.error) };
      } else {
        if (granted.grant.length !== PROOF_TOKEN_BYTES) return invalidProtocol();
        const payload = encodeRequest(request, granted.grant);
        preparing = true;
        beforeDispatch?.(requestId);
        preparing = false;
        sent = true;
        let reply = await pipe.exchange(payload, replyTimeout);
        while (reply.kind === "storageHydrate") {
          reply = await hydrate(reply, replyTimeout);
        }
        if (reply.kind === "storageTransition") {
          const snapshot = target.snapshot;
          if (
            expected === undefined ||
            snapshot === undefined ||
            !sameBytes(reply.requestId, requestId) ||
            reply.targetId !== target.targetId ||
            reply.writerEpoch !== snapshot.writerEpoch ||
            reply.expectedSeq !== snapshot.seq ||
            reply.disconnected !== (expected === "disconnected")
          )
            return invalidProtocol();
          let seq: number | undefined;
          try {
            const result = await Effect.runPromise(
              applySshOwnerTransition(sql, {
                writerEpoch: snapshot.writerEpoch,
                targetId: target.targetId,
                expectedSeq: snapshot.seq,
                requestId: requestId.toString("hex"),
                desiredState: expected,
              }),
            );
            if (result.kind === "committed") {
              seq = result.seq;
              committed = true;
            }
          } catch {
            // No successful receipt means admission must remain closed until fresh hydration.
          }
          storageFailed = !committed;
          if (seq !== undefined) snapshot.seq = seq;
          reply = await pipe.exchange(encodeStorageResult(requestId, seq));
          while (reply.kind === "storageHydrate") {
            reply = await hydrate(reply, replyTimeout);
          }
        }
        if (
          reply.kind !== "reply" ||
          !sameBytes(reply.requestId, requestId) ||
          !sameBytes(reply.ownerEpoch, ownerEpoch)
        ) {
          return invalidProtocol();
        }
        outcome = reply.outcome;
        if (outcome.kind === "connection") {
          if (
            !committed ||
            outcome.value.state !== expected ||
            reply.generation.length !== PROOF_TOKEN_BYTES ||
            sameBytes(reply.generation, target.generation)
          ) {
            return invalidProtocol();
          }
          target.generation = reply.generation;
        } else if (committed) return invalidProtocol();
        else if (!sameBytes(reply.generation, target.generation)) {
          // A first use and a stale refusal both report the target's current
          // generation; anything else is a protocol violation.
          if (target.generation.length !== 0) return invalidProtocol();
          if (reply.generation.length !== PROOF_TOKEN_BYTES && reply.generation.length !== 0) {
            return invalidProtocol();
          }
          target.generation = reply.generation;
        }
      }
      if (outcome.kind !== "error" && outcome.kind !== expectedOutcome[operation.kind])
        return invalidProtocol();
      if (operation.kind === "proofWorkspaceRead" && outcome.kind === "proofWorkspaceFile") {
        verifyWorkspaceFile(operation.read, outcome.value);
      }
      if (operation.kind === "proofWorkspaceGit" && outcome.kind === "proofWorkspaceGit") {
        verifyWorkspaceGitResult(operation.action, outcome.value);
      }
      if (
        operation.kind === "proofWorkspaceContentSearch" &&
        outcome.kind === "proofWorkspaceContentMatches" &&
        outcome.value.matches.length > operation.limit
      ) {
        return invalidProtocol();
      }
      if (outcome.kind === "proofTerminal") {
        if (
          "lease" in operation &&
          operation.lease !== undefined &&
          !sameBytes(outcome.value.lease, operation.lease)
        )
          return invalidProtocol();
        if (operation.kind === "closeProofTerminal" && outcome.value.live) return invalidProtocol();
      }
      if (outcome.kind === "proofTerminalReplay" && operation.kind === "proofTerminalReplay") {
        verifyProofTerminalReplay(operation, outcome.value);
      }
      if (
        outcome.kind === "proofTerminalCwd" &&
        operation.kind === "proofTerminalCwd" &&
        outcome.value !== operation.cwd
      )
        return invalidProtocol();
      if (outcome.kind === "proofTerminalReservation") {
        const cancelling = operation.kind === "cancelProofTerminalReservation";
        if (
          outcome.value.cancelled !== cancelling ||
          (cancelling && !sameBytes(outcome.value.lease, operation.lease))
        )
          return invalidProtocol();
      }
      if (outcome.kind === "proofAgentProxy" && "pid" in operation) {
        if (outcome.value.pid !== operation.pid || !sameBytes(outcome.value.lease, operation.lease))
          return invalidProtocol();
      }
    } catch (error) {
      if (
        preparing ||
        (error instanceof PickerProofOwnerError && error.code === "invalidOperands" && !sent)
      )
        throw error;
      failClosed();
      if (sent && (expected !== undefined || operation.kind === "approveTrust" || proofMutation)) {
        throw new PickerProofOwnerError("outcomeUnknown");
      }
      throw error;
    }
    if (storageFailed) {
      failClosed();
      throw new PickerProofOwnerError("storageUnavailable");
    }
    if (outcome.kind === "error") {
      // A correlated close timeout can still be reconciled by read-only status.
      const unknown = outcome.code === "outcomeUnknown";
      if (sent && proofMutation && unknown && operation.kind !== "closeProofAgentProxy")
        failClosed();
      throw new PickerProofOwnerError(outcome.code, outcome.jumpFailure);
    }
    return outcome;
  }

  return { run, hydrate };
}
