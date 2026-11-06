import { assert, it } from "@effect/vitest";
import type {
  ThreadOrganizationNativeOperation,
  ThreadOrganizationNativeOutcome,
} from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandPreviouslyRejectedError } from "../orchestration/Errors.ts";
import { makeOrganizationProposalHandler } from "./organizationBridge.proposals.ts";
import { recoverOrganizationOperations } from "./organizationBridge.startup.ts";
import type { OrganizationFrame } from "./organizationProtocol.ts";

type Input = Parameters<typeof makeOrganizationProposalHandler>[0];
const operation = {
  operationId: "rejected",
  occurrenceId: "occurrence",
  attempt: 0,
  threadId: "thread",
  backendNonce: "owner",
  generation: 1,
  policyVersion: 1,
  factVersion: 2,
  expectedRevision: 1,
  from: "present",
  destination: "later",
  reason: "idle",
  snoozeId: null,
  inactivityCutoffMs: null,
  createdAtMs: 1000,
} as ThreadOrganizationNativeOperation;

/** Ledger fake whose canonical command was durably rejected (a path no producer has today). */
const harness = () => {
  let outcome: ThreadOrganizationNativeOutcome | null = null;
  const settled: ThreadOrganizationNativeOutcome[] = [];
  const operations = {
    pending: () => Effect.sync(() => (outcome ? [] : [{ operation, outcome }])),
    prepare: () =>
      Effect.sync(() => ({ status: "prepared" as const, value: { operation, outcome } })),
    read: () => Effect.sync(() => ({ operation, outcome })),
    settle: (_id: string, value: ThreadOrganizationNativeOutcome) =>
      Effect.sync(() => {
        settled.push(value);
        outcome = value;
        return "applied" as const;
      }),
  } as unknown as Input["operations"];
  const engine = {
    dispatch: () =>
      Effect.fail(
        new OrchestrationCommandPreviouslyRejectedError({
          commandId: operation.operationId,
          detail: "rejected receipt",
        }),
      ),
  } as unknown as Input["engine"];
  return { operations, engine, settled };
};

it.effect("recovery settles a previously rejected operation as stale instead of latching", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* recoverOrganizationOperations(test.engine, test.operations);
    assert.deepEqual(test.settled, [{ status: "stale" }]);
    // The next attempt finds nothing pending: recovery cannot fail on the same row again.
    yield* recoverOrganizationOperations(test.engine, test.operations);
    assert.equal(test.settled.length, 1);
  }),
);

it.effect("a live proposal whose command was previously rejected returns a stale receipt", () =>
  Effect.gen(function* () {
    const test = harness();
    const sent: OrganizationFrame[] = [];
    const handle = makeOrganizationProposalHandler({
      epoch: { backendNonce: "owner", generation: 1 },
      engine: test.engine,
      operations: test.operations,
      refresh: () => Effect.void,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
    });
    yield* handle({
      operationId: "rejected",
      occurrenceId: "occurrence",
      attempt: 0,
      threadId: "thread",
      factVersion: 2,
      expectedRevision: 1,
      policyVersion: 1,
      from: 2,
      destination: 3,
      reason: 5,
      snoozeIdentity: "",
      createdAtMs: 1000,
    });
    assert.deepEqual(test.settled, [{ status: "stale" }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, "receipt");
  }),
);
