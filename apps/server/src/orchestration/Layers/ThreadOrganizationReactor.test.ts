import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { BackendInstance } from "../../startup/backendInstance.ts";
import { organizationStatus } from "../../thread-organization/organizationStatus.ts";
import { ThreadOrganizationReactor } from "../Services/ThreadOrganizationReactor.ts";
import { ThreadOrganizationReactorLive } from "./ThreadOrganizationReactor.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

it(
  "unavailable native scheduling pauses while manual moves remain available, with no TS fallback",
  () =>
    withDatabase("inyosira-single-scheduler-", async (path) => {
      vi.stubEnv("BIGBUD_THREAD_ORGANIZATION_BINARY", path + ".missing");
      const runtime = createRuntime(path);
      try {
        const engine = await engineFor(runtime);
        const threadId = ThreadId.makeUnsafe("paused-thread");
        for (const command of createCommands(ProjectId.makeUnsafe("paused-project"), [threadId]))
          await runtime.runPromise(engine.dispatch(command));
        const fiber = runtime.runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const reactor = yield* ThreadOrganizationReactor;
              yield* reactor.start();
              yield* reactor.start();
              return yield* Effect.never;
            }).pipe(
              Effect.provide(ThreadOrganizationReactorLive),
              Effect.provideService(BackendInstance, {
                nonce: "paused-test",
                pid: process.pid,
                startedAt: null,
                hostname: "fixture",
                machineId: null,
                stateDir: path,
                lockPath: path + ".lock",
                assertHeld: async () => {},
                classifyOwner: () => "dead",
              }),
            ),
          ),
        );
        try {
          await expect
            .poll(() =>
              runtime.runPromise(
                Effect.gen(function* () {
                  return organizationStatus(yield* SqlClient.SqlClient).state;
                }),
              ),
            )
            .toBe("paused");
          const at = new Date().toISOString();
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe("paused-approval"),
              threadId,
              activity: {
                id: EventId.makeUnsafe("paused-event"),
                kind: "approval.requested",
                tone: "approval",
                summary: "Approval",
                turnId: null,
                payload: { requestId: "paused-request" },
                createdAt: at,
              },
              createdAt: at,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 1600));
          const state = () =>
            runtime.runPromise(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const [row] = yield* sql<{
                  state: string;
                }>`SELECT organization_state AS state FROM projection_threads WHERE thread_id = ${threadId}`;
                return row?.state;
              }),
            );
          expect(await state()).toBe("present");
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.organization.move",
              commandId: CommandId.makeUnsafe("manual-while-paused"),
              threadId,
              state: "later",
              createdAt: at,
            }),
          );
          expect(await state()).toBe("later");
        } finally {
          await runtime.runPromise(Fiber.interrupt(fiber));
        }
      } finally {
        await runtime.dispose();
        vi.unstubAllEnvs();
      }
    }),
  15000,
);
