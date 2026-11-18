import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makePeerDispatchService } from "./peerDispatch.service.ts";
import {
  CALLER_THREAD,
  FakeThread,
  FakeWorker,
  makePeerTestDeps,
  peerTestLayer,
  seedPairing,
} from "./peerDispatch.test.helpers.ts";
import { PeerPairingRepository } from "../persistence/Services/PeerPairings.ts";
import { PEER_TOOL_UNAVAILABLE, peerToolViaOrchestration, runPeerTool } from "./ThreadPeerTools.ts";

const call = (invocationId = "inv-1") => ({
  callerThreadId: CALLER_THREAD,
  invocationId,
  tool: "delegate_to_host" as const,
  arguments: { task: "Summarize the logs." },
});

it.effect("tool_unavailable_without_grant: no coordinator registered", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* peerToolViaOrchestration(call()), PEER_TOOL_UNAVAILABLE);
    assert.deepStrictEqual(yield* runPeerTool(null, call()), PEER_TOOL_UNAVAILABLE);
  }),
);

it.live("tool_unavailable_without_grant: awaiting, revoked and missing grants", () =>
  Effect.gen(function* () {
    const worker = new FakeWorker();
    const pairing = yield* seedPairing(false);
    const deps = yield* makePeerTestDeps(worker, new FakeThread());
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 300 });

    const awaiting = yield* runPeerTool(service, call("a"));
    assert.isTrue(awaiting.unavailable);
    assert.deepInclude(awaiting.error as object, { code: "grant-missing" });

    const pairings = yield* PeerPairingRepository;
    yield* pairings.recordGrant(pairing.pairingId, "00000001-0000-4000-8000-000000000009", "t");
    yield* pairings.revoke(pairing.pairingId, "t2");
    const revoked = yield* runPeerTool(service, call("b"));
    assert.isTrue(revoked.unavailable);
    assert.strictEqual(worker.calls.length, 0);

    // Outside remote mode there is no coordinator identity at all.
    const local = yield* makePeerDispatchService(
      yield* makePeerTestDeps(worker, new FakeThread(), { coordinatorAuthorityId: null }),
    );
    assert.isTrue((yield* runPeerTool(local, call("c"))).unavailable);

    // With an active grant the same call dispatches.
    yield* pairings.recordGrant(pairing.pairingId, "00000001-0000-4000-8000-000000000010", "t3");
    const active = yield* runPeerTool(service, call("d"));
    assert.isUndefined(active.unavailable);
    assert.isString(active.dispatchId);
    assert.strictEqual(worker.launches, 1);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.effect("argument validation never reaches the dispatcher", () =>
  Effect.gen(function* () {
    const fake = { delegate: () => Effect.die("unreachable") } as never;
    const missingTask = yield* runPeerTool(fake, { ...call(), arguments: {} });
    assert.isFalse(missingTask.ok);
    const missingId = yield* runPeerTool(fake, {
      ...call(),
      tool: "peer_dispatch_status",
      arguments: {},
    });
    assert.isFalse(missingId.ok);
  }),
);
