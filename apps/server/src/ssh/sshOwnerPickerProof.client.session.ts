import { makeProofProviderProbe } from "./sshOwnerPickerProof.client.providerLease.ts";
import * as Effect from "effect/Effect";
import { makePickerProofHealthClient } from "./sshOwnerPickerProof.client.health.ts";
import {
  makePickerProofListClient,
  type SendPickerCancel,
} from "./sshOwnerPickerProof.client.list.ts";
import {
  encodeStorageSnapshot,
  OWNER_MAJOR,
  PickerProofOwnerError,
  type PickerProofOperation,
  type ProofTargetDescriptorInput,
} from "./sshOwnerPickerProof.codec.ts";
import { makePickerProofWorkspaceClient } from "./sshOwnerPickerProof.client.workspace.ts";
import { waitForProofAgentAdmission } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { makePickerProofTerminalClient } from "./sshOwnerPickerProof.client.terminal.ts";
import { makePickerProofProductionProxyClient } from "./sshOwnerPickerProof.client.productionProxy.ts";
import { makePickerProofShellClient } from "./sshOwnerPickerProof.client.shell.ts";
import { makePickerProofAgentActionClient } from "./sshOwnerPickerProof.client.agentAction.ts";
import { makePickerProofPeerEnrollmentClient } from "./sshOwnerPickerProof.client.peerEnrollment.ts";
import { makePickerProofAliasClient } from "./sshOwnerPickerProof.client.aliases.ts";
import type { ProofAgentProxyOperation } from "./sshOwnerPickerProof.codec.agentProxy.ts";
import { invalid as invalidProtocol } from "./sshOwnerPickerProof.codec.wire.ts";
import type { PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import { makePickerProofDeploymentClient } from "./sshOwnerPickerProof.deployment.ts";
import { makeProofTrackedGitClient } from "./sshOwnerPickerProof.client.trackedPush.ts";
import { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";
import {
  acceptPickerProofHello,
  type ExpectedReconciliation,
} from "./sshOwnerPickerProof.client.hello.ts";
import { encodeReconcileSnapshot } from "./sshOwnerPickerProof.codec.reconciliation.ts";
import {
  readSshOwnerHydrationSnapshot,
  type SshOwnerHydrationSnapshot,
} from "./sshOwnerProductionHydration.ts";
import {
  createSessionExchange,
  EMPTY,
  type TargetState,
} from "./sshOwnerPickerProof.client.session.exchange.ts";
import { EMPTY_SNAPSHOT, hydrated } from "./sshOwnerPickerProof.client.session.storage.ts";
import {
  type PickerProofBoundTarget,
  type PickerProofOwner,
  type PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.types.ts";

export type {
  PickerProofBoundTarget,
  PickerProofOwner,
  PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.types.ts";

export async function openPickerProofSession(
  pipe: PickerProofPipe,
  {
    targetId,
    sql,
    major,
    profileBinding,
    profileScope,
  }: Required<Omit<PickerProofSessionOptions, "targetId" | "profileScope">> &
    Pick<PickerProofSessionOptions, "targetId" | "profileScope">,
  handshake: () => ReturnType<PickerProofPipe["exchange"]>,
  sendPickerCancel?: SendPickerCancel,
  onLost?: (listener: () => void) => () => void,
) {
  const states = new Map<string, TargetState>();
  const primary: TargetState | undefined =
    targetId === undefined ? undefined : { targetId, generation: EMPTY };
  if (primary) states.set(primary.targetId, primary);
  let ownerEpoch: Uint8Array;
  let ownerMultiTarget = false;
  let aliasDescriptor: Uint8Array | undefined;
  let defaultTarget: TargetState | undefined;
  let reconciliation: PickerProofOwner["reconciliation"];
  let acknowledgedSnapshot: SshOwnerHydrationSnapshot | undefined;
  try {
    let first = await handshake();
    if (major !== OWNER_MAJOR) throw new PickerProofOwnerError("versionIncompatible");
    // A production owner requests the restart reconciliation before it accepts
    // the session. Answer every round; the acknowledgement is bound to the last.
    let expected: ExpectedReconciliation | undefined;
    let reconciliationFailed = false;
    while (first.kind === "reconcileHydrate") {
      const round = first;
      if (profileScope === undefined) return invalidProtocol();
      let snapshot: SshOwnerHydrationSnapshot = EMPTY_SNAPSHOT;
      let error: "storageUnavailable" | undefined;
      try {
        snapshot = await Effect.runPromise(readSshOwnerHydrationSnapshot(sql, profileScope));
      } catch {
        error = "storageUnavailable";
        reconciliationFailed = true;
      }
      const encoded = encodeReconcileSnapshot(round.requestId, snapshot, error);
      if (error === undefined) acknowledgedSnapshot = snapshot;
      expected = { requestId: round.requestId, digest: encoded.digest };
      first = await pipe.exchange(encoded.payload);
    }
    let accepted: ReturnType<typeof acceptPickerProofHello>;
    if (first.kind === "storageHydrate") {
      // Pinned fixture handshake: storage first, then acceptance.
      if (!primary || first.targetId !== primary.targetId) return invalidProtocol();
      try {
        primary.snapshot = await hydratePickerProofTarget(sql, primary.targetId);
      } catch {
        await pipe
          .exchange(encodeStorageSnapshot(primary.targetId, undefined))
          .catch(() => undefined);
        throw new PickerProofOwnerError("storageUnavailable");
      }
      accepted = acceptPickerProofHello(
        await pipe.exchange(encodeStorageSnapshot(primary.targetId, primary.snapshot)),
        major,
        profileBinding,
      );
      primary.generation = accepted.generation;
      defaultTarget = primary;
    } else if (first.kind === "helloAccepted") {
      // Production owner without a pinned target: acceptance first; each target
      // hydrates on its first admitted request.
      accepted = acceptPickerProofHello(first, major, profileBinding, expected);
      if (reconciliationFailed && accepted.reconciliation !== undefined) return invalidProtocol();
      if (accepted.multiTarget) {
        if (primary) {
          primary.generation = EMPTY;
          defaultTarget = primary;
        }
      } else {
        if (!primary) return invalidProtocol();
        primary.generation = accepted.generation;
        defaultTarget = primary;
      }
    } else return invalidProtocol();
    ({ ownerEpoch, aliasDescriptor } = accepted);
    ownerMultiTarget = accepted.multiTarget;
    reconciliation =
      accepted.reconciliation === undefined
        ? undefined
        : {
            acknowledged: accepted.reconciliation.acknowledged,
            retirements: accepted.reconciliation.retirements,
            panes: accepted.reconciliation.panes,
          };
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
  const exchange = createSessionExchange({
    pipe,
    sql,
    ownerEpoch,
    states,
    failClosed,
  });
  const run = exchange.run;
  const execute = async (
    operation: PickerProofOperation,
    beforeDispatch?: (id: Uint8Array) => void,
  ) => {
    if (closed) throw new PickerProofOwnerError("ownerUnavailable");
    if (active || proxyCloseWaiting) throw new PickerProofOwnerError("operationDenied");
    const current = run(defaultTarget, operation, beforeDispatch);
    active = current;
    activeKind = operation.kind;
    try {
      return await current;
    } finally {
      active = undefined;
      activeKind = undefined;
    }
  };

  /**
   * Binds one target for per-target requests. The descriptor is sent with every
   * request; the owner keeps the generation and reports it back.
   */
  const bindTarget = (descriptor: ProofTargetDescriptorInput): PickerProofBoundTarget => {
    const existing = states.get(descriptor.targetId);
    const state: TargetState = existing ?? {
      targetId: descriptor.targetId,
      generation: descriptor.generation ?? EMPTY,
    };
    state.descriptor = descriptor;
    if (descriptor.generation !== undefined && descriptor.generation.length > 0) {
      state.generation = descriptor.generation;
    }
    states.set(state.targetId, state);
    const runBound = async (
      operation: PickerProofOperation,
      beforeDispatch?: (id: Uint8Array) => void,
    ) => {
      if (closed) throw new PickerProofOwnerError("ownerUnavailable");
      if (active || proxyCloseWaiting) throw new PickerProofOwnerError("operationDenied");
      const current = run(state, operation, beforeDispatch);
      active = current;
      activeKind = operation.kind;
      try {
        return await current;
      } finally {
        active = undefined;
        activeKind = undefined;
      }
    };
    // OpenCode leases poll their status while other targets (or this one) use
    // the same single-flight owner session. Wait for the in-flight exchange,
    // bounded by its own deadline, instead of refusing a concurrent poll; the
    // re-check and dispatch run in one synchronous step.
    const runOpencode = async (operation: PickerProofOperation) => {
      for (;;) {
        if (closed || (!active && !proxyCloseWaiting)) return runBound(operation);
        if (active) await active.catch(() => undefined);
        else await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const trust = async (operation: PickerProofOperation) => {
      const outcome = await runBound(operation);
      return outcome.kind === "trust" ? outcome.value : invalidProtocol();
    };
    return {
      targetId: state.targetId,
      get generation() {
        return Uint8Array.from(state.generation);
      },
      get hydratedStorage() {
        return hydrated(state.snapshot);
      },
      ...makePickerProofTerminalClient(
        (operation) => runBound(operation),
        () => ({
          ownerEpoch: Uint8Array.from(ownerEpoch),
          targetGeneration: Uint8Array.from(state.generation),
        }),
      ),
      inspectTrust: () => trust({ kind: "inspectTrust" }),
      async approveTrust(challenge) {
        if (!challenge.length || challenge.length > 1_024)
          throw new PickerProofOwnerError("invalidOperands");
        return trust({ kind: "approveTrust", challenge: Uint8Array.from(challenge) });
      },
      async connect() {
        const outcome = await runBound({ kind: "connect" });
        return outcome.kind === "connection" ? outcome.value : invalidProtocol();
      },
      async disconnect() {
        const outcome = await runBound({ kind: "disconnect" });
        return outcome.kind === "connection" ? outcome.value : invalidProtocol();
      },
      ...makePickerProofListClient(state.targetId, runBound, sendPickerCancel),
      ...makePickerProofHealthClient(
        state.targetId,
        (beforeDispatch) => runBound({ kind: "proofSampleHealth" }, beforeDispatch),
        sendPickerCancel,
      ),
      ...makePickerProofProductionProxyClient((operation) =>
        operation.kind.startsWith("proofOpencode") ? runOpencode(operation) : runBound(operation),
      ),
    };
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
  const transition = async (kind: "connect" | "disconnect") => {
    if (active && activeKind?.startsWith("proofOpencode")) await active.catch(() => undefined);
    const outcome = await execute({ kind });
    return outcome.kind === "connection" ? outcome.value : invalidProtocol();
  };

  const stopAdmission = async () => {
    closed = true;
    await active?.catch(() => undefined);
  };
  const generation = () => {
    if (!defaultTarget) throw new PickerProofOwnerError("invalidOperands");
    return defaultTarget.generation;
  };
  const trackedGit = makeProofTrackedGitClient(targetId ?? "", () => generation(), execute);
  const owner: PickerProofOwner = {
    get trackedGitTargetGeneration() {
      return trackedGit.trackedGitTargetGeneration;
    },
    receiveTrackedPush: trackedGit.receiveTrackedPush,
    get ownerEpoch() {
      return Uint8Array.from(ownerEpoch);
    },
    get multiTarget() {
      return ownerMultiTarget;
    },
    get targetGeneration() {
      return Uint8Array.from(generation());
    },
    get aliasDescriptor() {
      return aliasDescriptor && Uint8Array.from(aliasDescriptor);
    },
    get hydratedStorage() {
      return hydrated(defaultTarget?.snapshot);
    },
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(acknowledgedSnapshot === undefined ? {} : { acknowledgedSnapshot }),
    onLost: onLost ?? (() => () => {}),
    bindTarget,
    inspectTrust: () => trust({ kind: "inspectTrust" }),
    async approveTrust(challenge) {
      if (!challenge.length || challenge.length > 1_024)
        throw new PickerProofOwnerError("invalidOperands");
      return trust({ kind: "approveTrust", challenge: Uint8Array.from(challenge) });
    },
    ...makePickerProofListClient(targetId ?? "", execute, sendPickerCancel),
    ...makePickerProofAliasClient(execute),
    ...makePickerProofWorkspaceClient(targetId ?? "", execute, sendPickerCancel),
    ...makePickerProofDeploymentClient(targetId ?? "", execute),
    connect: () => transition("connect"),
    disconnect: () => transition("disconnect"),
    ...makePickerProofTerminalClient(execute, () => ({
      ownerEpoch: Uint8Array.from(ownerEpoch),
      targetGeneration: Uint8Array.from(generation()),
    })),
    ...makePickerProofShellClient(execute),
    ...makePickerProofPeerEnrollmentClient(execute),
    async unlockSyntheticPosixPassword() {
      const outcome = await execute({ kind: "unlockSyntheticPosixPassword" });
      if (outcome.kind !== "proofSyntheticPosixPasswordUnlocked") return invalidProtocol();
    },
    ...makePickerProofHealthClient(
      targetId ?? "",
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
    bindTarget,
    stopAdmission,
    executeProofAgentProxy,
    /** Generic owner exchange for compositions that need a production-proxy client. */
    executeProofOperation: execute,
    opencodeBinding: () => ({
      ownerEpoch: Uint8Array.from(ownerEpoch),
      targetGeneration: Uint8Array.from(generation()),
    }),
    probeProofProvider: makeProofProviderProbe(targetId ?? "", execute),
    executeAgentAction: makePickerProofAgentActionClient(targetId ?? "", execute),
  };
}
