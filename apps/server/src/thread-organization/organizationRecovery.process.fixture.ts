import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  createCommands,
  createRuntime,
  engineFor,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { makeOrganizationBridge } from "./organizationBridge.ts";
import { dispatchOrganizationOperation } from "./organizationBridge.proposals.ts";
import { recoverOrganizationOperations } from "./organizationBridge.startup.ts";
import { organizationOwner } from "./organizationOwner.ts";

const [path, binary, phase, oldId] = process.argv.slice(2);
if (!path || !binary || !phase) throw new Error("missing recovery fixture arguments");
process.env.BIGBUD_THREAD_ORGANIZATION_BINARY = binary;
const threadId = ThreadId.makeUnsafe("process-recovery-thread");
const runtime = createRuntime(path);
const engine = await engineFor(runtime);
const ledger = await runtime.runPromise(makeThreadOrganizationOperations);
const backend: typeof BackendInstance.Service = {
  nonce: `recovery-${process.pid}`,
  pid: process.pid,
  startedAt: null,
  hostname: "synthetic",
  machineId: null,
  stateDir: path,
  lockPath: path + ".lock",
  assertHeld: async () => {},
  classifyOwner: () => "dead",
};
if (phase !== "recover") {
  for (const command of createCommands(ProjectId.makeUnsafe("process-recovery"), [threadId]))
    await runtime.runPromise(engine.dispatch(command));
  const at = new Date().toISOString();
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe("process-request"),
      threadId,
      activity: {
        id: EventId.makeUnsafe("process-approval"),
        kind: "approval.requested",
        turnId: null,
        tone: "info",
        summary: "Synthetic approval",
        createdAt: at,
        payload: { requestId: "process-request", requestKind: "command" },
      },
      createdAt: at,
    }),
  );
}
let recovered: unknown;
if (phase === "recover") {
  recovered = await runtime.runPromise(
    Effect.gen(function* () {
      const operations = yield* makeThreadOrganizationOperations;
      yield* recoverOrganizationOperations(engine, operations);
      const record = yield* operations.read(oldId!);
      if (!record?.outcome) return yield* Effect.die("lost durable outcome");
      // Replay under the replacement process must return the stored outcome, not move again.
      yield* dispatchOrganizationOperation(engine, operations, record.operation);
      return record.outcome;
    }),
  );
}
const intercepted: typeof engine = {
  ...engine,
  dispatch: (command, options) =>
    Effect.gen(function* () {
      if (command.type !== "thread.organization.react" || phase === "recover")
        return yield* engine.dispatch(command, options);
      // The production handler has durably prepared the operation before dispatching.
      if (phase === "prepared") {
        process.send?.({ state: "barrier", operationId: command.commandId });
        return yield* Effect.never;
      }
      yield* engine.dispatch(command, options);
      const record = yield* ledger.read(command.commandId);
      process.send?.({
        state: "barrier",
        operationId: command.commandId,
        outcome: record?.outcome,
      });
      // Canonical commit is durable, but no receipt has reached the real Rust process.
      return yield* Effect.never;
    }),
};
const bridge = await runtime.runPromise(
  makeOrganizationBridge.pipe(
    Effect.provideService(BackendInstance, backend),
    Effect.provideService(OrchestrationEngineService, intercepted),
  ),
);
const fiber = runtime.runFork(Effect.scoped(bridge.run()));
if (phase === "recover") {
  const deadline = Date.now() + 15000;
  while (true) {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ state: string; revision: number }>`SELECT
          organization_state AS state, organization_revision AS revision
          FROM projection_threads WHERE thread_id = ${threadId}`;
        const [events] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
          FROM orchestration_events WHERE event_type = 'thread.organization-updated'`;
        const operations = yield* makeThreadOrganizationOperations;
        return {
          ...row,
          count: events?.count,
          pending: (yield* operations.pending()).length,
          active: organizationOwner(sql)?.active,
        };
      }),
    );
    if (result.active && result.state === "needs-you" && result.pending === 0) {
      await runtime.runPromise(Fiber.interrupt(fiber));
      await runtime.dispose();
      process.send?.({ ...result, state: "recovered", outcome: recovered });
      process.disconnect?.();
      break;
    }
    if (Date.now() > deadline) throw new Error("replacement bridge failed to converge");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
