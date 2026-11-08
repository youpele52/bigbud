import { assert, it } from "@effect/vitest";
import type { ThreadOrganizationNativeOutcome } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  makeOrganizationProposalHandler,
  ORGANIZATION_PROPOSAL_UNSETTLED_MS,
} from "./organizationBridge.proposals.ts";
import type { OrganizationFrame, OrganizationProposal } from "./organizationProtocol.ts";

type Input = Parameters<typeof makeOrganizationProposalHandler>[0];
const proposal: OrganizationProposal = {
  operationId: "operation",
  occurrenceId: "occurrence",
  attempt: 0,
  threadId: "thread",
  factVersion: 2,
  expectedRevision: 1,
  policyVersion: 1,
  from: 3,
  destination: 2,
  reason: 2,
  snoozeIdentity: "",
  createdAtMs: 1000,
};
const applied: ThreadOrganizationNativeOutcome = {
  status: "applied",
  resultRevision: 2,
  resultSequence: 9,
};

/** Ledger fake: dispatch settles the outcome, exactly like serialized canonical acceptance. */
const harness = (dispatchDelay: Duration.Input, settledBefore = false) => {
  let outcome: ThreadOrganizationNativeOutcome | null = settledBefore ? applied : null;
  let dispatches = 0;
  const sent: OrganizationFrame[] = [];
  const refreshed: string[] = [];
  const operations = {
    prepare: (operation: unknown) =>
      Effect.succeed({
        status: outcome ? ("duplicate" as const) : ("prepared" as const),
        value: { operation, outcome },
      }),
    read: (operation: unknown) => Effect.succeed({ operation, outcome }),
  } as unknown as Input["operations"];
  const engine = {
    dispatch: () =>
      Effect.sleep(dispatchDelay).pipe(
        Effect.andThen(
          Effect.sync(() => {
            dispatches += 1;
            outcome = applied;
            return { sequence: 9 };
          }),
        ),
      ),
  } as unknown as Input["engine"];
  const handle = makeOrganizationProposalHandler({
    epoch: { backendNonce: "owner", generation: 1 },
    engine,
    operations,
    refresh: (id) => Effect.sync(() => void refreshed.push(id)),
    send: (frame) => Effect.sync(() => void sent.push(frame)),
  });
  return { handle, sent, refreshed, dispatches: () => dispatches };
};

it.effect("a 7s canonical delay produces one late receipt, never a receiver failure", () =>
  Effect.gen(function* () {
    const test = harness("7 seconds");
    const fiber = yield* Effect.forkChild(test.handle(proposal));
    yield* TestClock.adjust("6 seconds");
    assert.equal(test.sent.length, 0);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    assert.equal(test.dispatches(), 1);
    assert.deepEqual(test.refreshed, ["thread"]);
    assert.deepEqual(test.sent, [
      {
        backendNonce: "owner",
        generation: 1,
        type: "receipt",
        value: { operationId: "operation", outcome: 1, resultRevision: 2, resultSequence: 9 },
      },
    ]);
  }),
);

it.effect("a retransmitted proposal resends the durable receipt without dispatching again", () =>
  Effect.gen(function* () {
    const test = harness("0 millis", true);
    yield* test.handle(proposal);
    assert.equal(test.dispatches(), 0);
    assert.equal(test.sent.length, 1);
  }),
);

it.effect("a proposal still unsettled after its bound is a real fault", () =>
  Effect.gen(function* () {
    const test = harness("1 hour");
    const fiber = yield* Effect.forkChild(Effect.flip(test.handle(proposal)));
    yield* TestClock.adjust(ORGANIZATION_PROPOSAL_UNSETTLED_MS + 1);
    const error = yield* Fiber.join(fiber);
    assert.match(error.message, /unsettled/);
    assert.equal(test.sent.length, 0);
  }),
);
