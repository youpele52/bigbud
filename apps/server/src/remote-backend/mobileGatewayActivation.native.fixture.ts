/** Actual owner client over scripted native replies; preparation/assets/CAS are recorded only. */
import {
  connectNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type VerifiedNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { launch, stateDir } from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import {
  successorFixture,
  type SuccessorReply,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import {
  nativeMobileActivationPorts,
  type NativeMobileActivationAssets,
  type NativeMobileActivationPreparation,
} from "./mobileGatewayActivation.native.ts";
import { runMobileActivationWorker } from "./mobileGatewayActivation.worker.ts";

/** A fresh original grant for this controller, without any successor bootstrap. */
export const spawnedReply: SuccessorReply = {
  state: "spawned",
  bootstrap: [],
  previousController: undefined,
};
export const cancelledReply: SuccessorReply = {
  state: "cancelled",
  generation: 0,
  originalChildPid: 0,
  bootstrap: [],
  originalController: undefined,
  currentController: undefined,
  previousController: undefined,
};
export const detachedReply: SuccessorReply = { state: "detached", bootstrap: [] };

type Stage = "assets" | "receipt" | "prepare" | "reserve" | "mark-invoked";
export interface NativeActivationScenario {
  readonly script: Parameters<typeof successorFixture>[0];
  /** This preparation stage throws instead of settling. */
  readonly fail?: Stage;
  /** Durable reservation returns null: no fresh same-CAS intent. */
  readonly nullIntent?: boolean;
  /** "detach" aborts the detach signal while ready; "start" aborts it while Start is in flight. */
  readonly abortDetach?: "use" | "start";
  /** Observes the held lease and its owner client during `use`. */
  readonly inspect?: (lease: VerifiedNativeLease, client: NativeServiceLeaseClient) => void;
}

export async function runNativeActivation(scenario: NativeActivationScenario) {
  const f = successorFixture(scenario.script);
  const client = await connectNativeServiceLeaseClient(f.connection, {
    nativeEpoch: "epoch",
    stateDir,
  });
  const detach = new AbortController(),
    stop = new AbortController();
  const events: string[] = [];
  /** Each event records how many native frames were already on the wire. */
  const record = (event: string) => void events.push(`${event}@${f.sent().length}`);
  const step = (stage: Stage) => {
    record(stage);
    if (scenario.fail === stage) throw Error(`Fixture ${stage} failed.`);
  };
  const preparation: NativeMobileActivationPreparation<{ readonly nonce: string }, object> = {
    prepare: async (assets, attempt) => {
      step("prepare");
      if (assets.nonce !== client.attemptNonce(attempt)) throw Error("Fixture nonce mismatch.");
      return client.prepareStart(attempt, launch(assets.nonce));
    },
    reserve: async (pending) => {
      client.original(pending);
      step("reserve");
      return scenario.nullIntent ? null : Object.freeze({});
    },
    markInvoked: async () => {
      step("mark-invoked");
      if (scenario.abortDetach === "start") setTimeout(() => detach.abort(), 10);
    },
  };
  const assets: NativeMobileActivationAssets<
    { readonly nonce: string },
    { readonly kind: string }
  > = {
    prepare: async (nonce) => {
      step("assets");
      return Object.freeze({ nonce });
    },
    writeReceipt: async () => step("receipt"),
    confirmExit: async (_assets, owner, _pending, exit) => {
      const evidence = owner.exitEvidence(exit);
      record(`confirm:${evidence.kind}`);
      return Object.freeze({ kind: evidence.kind });
    },
    confirmCancellation: async (_assets, owner, _pending, cancellation) => {
      const evidence = owner.cancellationEvidence(cancellation);
      record(`confirm:${evidence.kind}`);
      return Object.freeze({ kind: evidence.kind });
    },
    remove: async (_assets, cleanup) => record(`remove:${cleanup?.kind ?? "unarmed"}`),
  };
  try {
    const result = await runMobileActivationWorker({
      ...nativeMobileActivationPorts(client, preparation, assets),
      detach: detach.signal,
      stop: stop.signal,
      withSelection: async (_signal, use) => use("selection"),
      use: async (lease) => {
        record("use");
        scenario.inspect?.(lease, client);
        if (scenario.abortDetach === "use") detach.abort();
        return "ready-value";
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    return { result, events, wire: f.sent() };
  } finally {
    await client.dispose();
  }
}
