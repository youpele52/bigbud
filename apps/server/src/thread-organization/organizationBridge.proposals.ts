import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import * as Effect from "effect/Effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import type { OrganizationFrame, OrganizationProposal } from "./organizationProtocol.ts";
import { OrganizationNativeFault } from "./organizationLifecycle.ts";
import {
  organizationOperationFromProposal,
  organizationReceiptForOutcome,
} from "./organizationProposal.wire.ts";

type Operations = Effect.Success<typeof makeThreadOrganizationOperations>;
type Epoch = { backendNonce: string; generation: number };

/** Bound on a proposal remaining unsettled. Ordinary canonical command latency (a large
 * project reconfigure, a paged snapshot) must surface as a late receipt, never a crash. Rust
 * gives up after its own acknowledgement budget (sent + retransmits at 5.2/5.4/5.8s, exit at
 * about 22.2s); this bound fires first so the fault names the slow command, not a child exit.
 */
export const ORGANIZATION_PROPOSAL_UNSETTLED_MS = 20_000;

/** The one canonical command that carries a native proposal into serialized acceptance. A
 * persisted rejection of that command (no path produces one today) settles the operation as
 * `stale` rather than leaving it prepared, so recovery can never latch on a single row.
 */
export function dispatchOrganizationOperation(
  engine: OrchestrationEngineShape,
  operations: Pick<Operations, "settle">,
  operation: ThreadOrganizationNativeOperation,
) {
  return engine
    .dispatch(
      {
        type: "thread.organization.react",
        commandId: CommandId.makeUnsafe(operation.operationId),
        threadId: ThreadId.makeUnsafe(operation.threadId),
        state: operation.destination,
        createdAt: new Date(operation.createdAtMs).toISOString(),
      },
      { nativeOrganizationOperation: operation },
    )
    .pipe(
      Effect.asVoid,
      Effect.catchTag("OrchestrationCommandPreviouslyRejectedError", () =>
        operations.settle(operation.operationId, { status: "stale" }).pipe(Effect.asVoid),
      ),
    );
}

/** Executes one native proposal: durable preparation, serialized canonical acceptance, a fresh
 * fact for the thread and only then the receipt. Duplicate retransmissions resolve against the
 * durable ledger and resend the identical receipt; no TS decision is made here.
 */
export function makeOrganizationProposalHandler(input: {
  epoch: Epoch;
  engine: OrchestrationEngineShape;
  operations: Operations;
  refresh: (threadId: string) => Effect.Effect<void, Error>;
  send: (frame: OrganizationFrame) => Effect.Effect<void, Error>;
}) {
  const { epoch, operations } = input;
  return (proposal: OrganizationProposal) =>
    Effect.gen(function* () {
      const operation = yield* Effect.try({
        try: () => organizationOperationFromProposal(epoch, proposal),
        catch: (cause) =>
          new OrganizationNativeFault({ message: "invalid native organisation proposal", cause }),
      });
      const prepared = yield* operations.prepare(operation);
      if (prepared.status === "capacity" || prepared.status === "conflict")
        return yield* Effect.fail(new Error("organisation proposal ledger refused preparation"));
      if (!prepared.value.outcome)
        yield* dispatchOrganizationOperation(input.engine, operations, operation);
      const settled = yield* operations.read(operation.operationId);
      if (!settled?.outcome)
        return yield* Effect.fail(new Error("organisation proposal outcome unknown"));
      yield* input.refresh(operation.threadId);
      yield* input.send({
        ...epoch,
        type: "receipt",
        value: organizationReceiptForOutcome(operation.operationId, settled.outcome),
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: ORGANIZATION_PROPOSAL_UNSETTLED_MS,
        orElse: () => Effect.fail(new Error("organisation proposal remained unsettled")),
      }),
    );
}
