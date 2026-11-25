import { makeProofProviderProbe } from "./sshOwnerPickerProof.client.providerLease.ts";
import { randomBytes } from "node:crypto";
import { makePickerProofHealthClient } from "./sshOwnerPickerProof.client.health.ts";
import {
  makePickerProofListClient,
  type SendPickerCancel,
} from "./sshOwnerPickerProof.client.list.ts";
import * as Effect from "effect/Effect";
import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import {
  decodeOwnerError,
  encodeRequest,
  encodeStorageResult,
  encodeStorageSnapshot,
  OWNER_MAJOR,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  type PickerProofOperation,
} from "./sshOwnerPickerProof.codec.ts";
import { makePickerProofWorkspaceClient } from "./sshOwnerPickerProof.client.workspace.ts";
import { waitForProofAgentAdmission } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { makePickerProofTerminalClient } from "./sshOwnerPickerProof.client.terminal.ts";
import { makePickerProofShellClient } from "./sshOwnerPickerProof.client.shell.ts";
import { makePickerProofAgentActionClient } from "./sshOwnerPickerProof.client.agentAction.ts";
import { makePickerProofPeerEnrollmentClient } from "./sshOwnerPickerProof.client.peerEnrollment.ts";
import { makePickerProofAliasClient } from "./sshOwnerPickerProof.client.aliases.ts";
import type { ProofAgentProxyOperation } from "./sshOwnerPickerProof.codec.agentProxy.ts";
import { verifyWorkspaceGitResult } from "./sshOwnerPickerProof.codec.git.ts";
import { verifyProofTerminalReplay } from "./sshOwnerPickerProof.codec.terminal.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid as invalidProtocol } from "./sshOwnerPickerProof.codec.wire.ts";
import { verifyWorkspaceFile } from "./sshOwnerPickerProof.codec.workspaceFile.ts";
import type { PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import { expectedOutcome } from "./sshOwnerPickerProof.client.expectedOutcome.ts";
import { makePickerProofDeploymentClient } from "./sshOwnerPickerProof.deployment.ts";
import { makeProofTrackedGitClient } from "./sshOwnerPickerProof.client.trackedPush.ts";
import type { ProofOpencodeOperation } from "./sshOwnerPickerProof.codec.opencode.ts";
import { proofRequestPolicy } from "./sshOwnerPickerProof.client.requestPolicy.ts";
import { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";
import { acceptPickerProofHello } from "./sshOwnerPickerProof.client.hello.ts";
import {
  type PickerProofOwner,
  type PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.types.ts";

export type {
  PickerProofOwner,
  PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.types.ts";

const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(right);

export async function openPickerProofSession(
  pipe: PickerProofPipe,
  { targetId, sql, major }: Required<PickerProofSessionOptions>,
  handshake: () => ReturnType<PickerProofPipe["exchange"]>,
  sendPickerCancel?: SendPickerCancel,
) {
  let snapshot: Awaited<ReturnType<typeof hydratePickerProofTarget>>;
  let ownerEpoch: Uint8Array;
  let generation: Uint8Array;
  let aliasDescriptor: Uint8Array | undefined;
  try {
    const hydration = await handshake();
    if (major !== OWNER_MAJOR) throw new PickerProofOwnerError("versionIncompatible");
    if (hydration.kind !== "storageHydrate" || hydration.targetId !== targetId)
      return invalidProtocol();
    try {
      snapshot = await hydratePickerProofTarget(sql, targetId);
    } catch {
      await pipe.exchange(encodeStorageSnapshot(targetId, undefined)).catch(() => undefined);
      throw new PickerProofOwnerError("storageUnavailable");
    }
    const accepted = acceptPickerProofHello(
      await pipe.exchange(encodeStorageSnapshot(targetId, snapshot)),
      major,
    );
    ({ ownerEpoch, generation, aliasDescriptor } = accepted);
  } catch (error) {
    await pipe.close();
    if (
      major !== OWNER_MAJOR &&
      error instanceof PickerProofOwnerError &&
      error.code === "ownerUnavailable"
    ) {
      throw new PickerProofOwnerError("versionIncompatible");
    }
    throw error;
  }

  let closed = false;
  let active: Promise<unknown> | undefined;
  let activeKind: PickerProofOperation["kind"] | undefined;
  let proxyCloseWaiting = false;

  const failClosed = () => {
    closed = true;
    void pipe.close();
  };

  async function run(operation: PickerProofOperation, beforeDispatch?: (id: Uint8Array) => void) {
    const requestId = randomBytes(16);
    const request = { requestId, ownerEpoch, generation, targetId, operation };
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
        if (reply.kind === "storageTransition") {
          if (
            expected === undefined ||
            !sameBytes(reply.requestId, requestId) ||
            reply.targetId !== targetId ||
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
                targetId,
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
            sameBytes(reply.generation, generation)
          ) {
            return invalidProtocol();
          }
          generation = reply.generation;
        } else if (committed || !sameBytes(reply.generation, generation)) return invalidProtocol();
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

  const execute = async (
    operation: PickerProofOperation,
    beforeDispatch?: (id: Uint8Array) => void,
  ) => {
    if (closed) throw new PickerProofOwnerError("ownerUnavailable");
    if (active || proxyCloseWaiting) throw new PickerProofOwnerError("operationDenied");
    const current = run(operation, beforeDispatch);
    active = current;
    activeKind = operation.kind;
    try {
      return await current;
    } finally {
      active = undefined;
      activeKind = undefined;
    }
  };
  const executeProofAgentProxy = async (
    operation: ProofAgentProxyOperation,
    beforeDispatch?: () => void,
  ) => {
    if (!closed) {
      if (operation.kind === "proofAgentProxyStatus" && (active || proxyCloseWaiting)) return;
      if (operation.kind === "closeProofAgentProxy" && active && !proxyCloseWaiting) {
        proxyCloseWaiting = true;
        try {
          await waitForProofAgentAdmission(active, operation.timeoutMs);
        } finally {
          proxyCloseWaiting = false;
        }
      }
    }
    const outcome = await execute(operation, beforeDispatch);
    return outcome.kind === "proofAgentProxy" ? outcome.value : invalidProtocol();
  };
  const trust = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "trust" ? outcome.value : invalidProtocol();
  };
  const executeProofOpencode = async (
    operation: ProofOpencodeOperation,
    beforeDispatch?: () => void,
  ) => {
    const inFlight = () => (closed ? undefined : active);
    for (let pending = inFlight(); pending; pending = inFlight())
      await pending.catch(() => undefined);
    const outcome = await execute(operation, beforeDispatch);
    return outcome.kind === "proofOpencode" ? outcome.value : invalidProtocol();
  };
  const transition = async (kind: "connect" | "disconnect") => {
    if (active && activeKind?.startsWith("proofOpencode")) await active.catch(() => undefined);
    const outcome = await execute({ kind });
    return outcome.kind === "connection" ? outcome.value : invalidProtocol();
  };

  const stopAdmission = async () => {
    closed = true;
    await active?.catch(() => undefined);
  };
  const trackedGit = makeProofTrackedGitClient(targetId, () => generation, execute);
  const owner: PickerProofOwner = {
    get trackedGitTargetGeneration() {
      return trackedGit.trackedGitTargetGeneration;
    },
    receiveTrackedPush: trackedGit.receiveTrackedPush,
    get ownerEpoch() {
      return Uint8Array.from(ownerEpoch);
    },
    get targetGeneration() {
      return Uint8Array.from(generation);
    },
    get aliasDescriptor() {
      return aliasDescriptor && Uint8Array.from(aliasDescriptor);
    },
    inspectTrust: () => trust({ kind: "inspectTrust" }),
    async approveTrust(challenge) {
      if (!challenge.length || challenge.length > 1_024)
        throw new PickerProofOwnerError("invalidOperands");
      return trust({ kind: "approveTrust", challenge: Uint8Array.from(challenge) });
    },
    ...makePickerProofListClient(targetId, execute, sendPickerCancel),
    ...makePickerProofAliasClient(execute),
    ...makePickerProofWorkspaceClient(targetId, execute, sendPickerCancel),
    ...makePickerProofDeploymentClient(targetId, execute),
    connect: () => transition("connect"),
    disconnect: () => transition("disconnect"),
    ...makePickerProofTerminalClient(execute, () => ({
      ownerEpoch: Uint8Array.from(ownerEpoch),
      targetGeneration: Uint8Array.from(generation),
    })),
    ...makePickerProofShellClient(execute),
    ...makePickerProofPeerEnrollmentClient(execute),
    async unlockSyntheticPosixPassword() {
      const outcome = await execute({ kind: "unlockSyntheticPosixPassword" });
      if (outcome.kind !== "proofSyntheticPosixPasswordUnlocked") return invalidProtocol();
    },
    ...makePickerProofHealthClient(
      targetId,
      (beforeDispatch) => execute({ kind: "proofSampleHealth" }, beforeDispatch),
      sendPickerCancel,
    ),
    async close() {
      await stopAdmission();
      await pipe.close();
    },
  };
  return {
    owner,
    stopAdmission,
    executeProofAgentProxy,
    executeProofOpencode,
    opencodeBinding: () => ({
      ownerEpoch: Uint8Array.from(ownerEpoch),
      targetGeneration: Uint8Array.from(generation),
    }),
    probeProofProvider: makeProofProviderProbe(targetId, execute),
    executeAgentAction: makePickerProofAgentActionClient(targetId, execute),
  };
}
