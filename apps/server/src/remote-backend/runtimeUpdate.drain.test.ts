import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { RemoteRuntimeUpdateAffectedWork } from "@bigbud/contracts/server/remoteBackendUpdate.ts";

import { makeRuntimeMaintenanceGate } from "../command-admission/RuntimeMaintenanceGate.ts";
import { countingGate } from "./runtimeUpdate.activate.test.helpers.ts";
import { drainForRuntimeUpdate, type RuntimeUpdateDrainProbe } from "./runtimeUpdate.drain.ts";
import { runtimeUpdateError } from "./runtimeUpdate.states.ts";

const turn = (thread: string): RemoteRuntimeUpdateAffectedWork => ({
  kind: "turn",
  id: `${thread}#turn`,
  label: thread,
});
const approval = (thread: string): RemoteRuntimeUpdateAffectedWork => ({
  kind: "approval",
  id: `${thread}#approval`,
  label: thread,
});

function fakeProbe(initial: Array<RemoteRuntimeUpdateAffectedWork>, stubborn: Array<string> = []) {
  const state = { work: [...initial], interrupted: [] as Array<string> };
  const probe: RuntimeUpdateDrainProbe = {
    affectedWork: Effect.sync(() => [...state.work]),
    settleCommands: Effect.void,
    interruptThread: (thread) =>
      Effect.sync(() => {
        state.interrupted.push(thread);
        // A cooperative provider settles its turn (and the approval it was waiting on).
        if (!stubborn.includes(thread))
          state.work = state.work.filter((item) => !item.id.startsWith(`${thread}#`));
      }),
  };
  return { state, probe };
}

const drainOptions = { pollMs: 5, settleTimeoutMs: 100, inFlightTimeoutMs: 100 };

it.effect("busy_turn_defers_automatic_update", () =>
  Effect.gen(function* () {
    const gate = countingGate(false);
    const { state, probe } = fakeProbe([turn("thread-a")]);
    const outcome = yield* drainForRuntimeUpdate({
      gate,
      probe,
      interrupting: false,
      consumeConsent: Effect.die("automatic updates never consume consent"),
      ...drainOptions,
    });
    assert.equal(outcome.kind, "deferred");
    assert.equal(gate.closes, 0, "a deferred automatic update never closes admission");
    assert.deepStrictEqual(state.interrupted, []);
    // Once the turn finishes the same drain closes admission and reports nothing interrupted.
    state.work = [];
    const drained = yield* drainForRuntimeUpdate({
      gate,
      probe,
      interrupting: false,
      consumeConsent: Effect.die("unused"),
      ...drainOptions,
    });
    assert.deepStrictEqual(drained, { kind: "drained", interrupted: [], uncertain: [] });
    assert.isTrue(gate.isClosed());
    const refused = yield* gate.guard(Effect.succeed("admitted")).pipe(Effect.flip);
    assert.equal(refused.code, "overloaded");
    assert.equal(gate.admitted(), 0);
  }),
);

it.effect("pending_approval_blocks_automatic", () =>
  Effect.gen(function* () {
    const gate = countingGate(false);
    const { state, probe } = fakeProbe([approval("thread-b")]);
    const outcome = yield* drainForRuntimeUpdate({
      gate,
      probe,
      interrupting: false,
      consumeConsent: Effect.die("unused"),
      ...drainOptions,
    });
    assert.equal(outcome.kind, "deferred");
    if (outcome.kind === "deferred")
      assert.deepStrictEqual(outcome.blocking, [approval("thread-b")]);
    assert.equal(gate.closes, 0);
    assert.deepStrictEqual(state.interrupted, [], "the approval wait is left intact");
    // Work that appears after admission closed reopens it and defers.
    let reads = 0;
    const racing: RuntimeUpdateDrainProbe = {
      ...probe,
      affectedWork: Effect.sync(() => (reads++ === 0 ? [] : [approval("thread-c")])),
    };
    const raced = yield* drainForRuntimeUpdate({
      gate,
      probe: racing,
      interrupting: false,
      consumeConsent: Effect.die("unused"),
      ...drainOptions,
    });
    assert.equal(raced.kind, "deferred");
    assert.isFalse(gate.isClosed());
  }),
);

it.live("interrupting_update_settles_or_reports_uncertain", () =>
  Effect.gen(function* () {
    const gate = makeRuntimeMaintenanceGate({ initiallyClosed: false });
    const { state, probe } = fakeProbe(
      [turn("thread-a"), approval("thread-a"), turn("thread-z")],
      ["thread-z"],
    );
    let consumed = 0;
    const outcome = yield* drainForRuntimeUpdate({
      gate,
      probe,
      interrupting: true,
      consumeConsent: Effect.sync(() => {
        consumed += 1;
        assert.isTrue(gate.isClosed(), "consent is consumed only after admission closed");
      }),
      ...drainOptions,
    });
    assert.equal(consumed, 1);
    // Each thread is interrupted exactly once (never replayed); the stubborn one is uncertain.
    assert.deepStrictEqual(state.interrupted, ["thread-a", "thread-z"]);
    assert.deepStrictEqual(outcome, {
      kind: "drained",
      interrupted: ["thread-a"],
      uncertain: ["thread-z"],
    });
    assert.isTrue(gate.isClosed());

    // Stale consent interrupts nothing and reopens admission.
    const other = fakeProbe([turn("thread-q")]);
    const reopened = makeRuntimeMaintenanceGate({ initiallyClosed: false });
    const stale = yield* drainForRuntimeUpdate({
      gate: reopened,
      probe: other.probe,
      interrupting: true,
      consumeConsent: Effect.fail(
        runtimeUpdateError("consent-stale", "The affected work changed."),
      ),
      ...drainOptions,
    }).pipe(Effect.flip);
    assert.equal(stale.code, "consent-stale");
    assert.deepStrictEqual(other.state.interrupted, []);
    assert.isFalse(reopened.isClosed());
  }),
);
