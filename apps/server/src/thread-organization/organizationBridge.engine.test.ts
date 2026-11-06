import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { makeOrganizationBridge } from "./organizationBridge.ts";
import { organizationOwner } from "./organizationOwner.ts";

const binary = resolve(
  import.meta.dirname,
  "../../../../target/debug/bigbud-desktop-supervisor" +
    (process.platform === "win32" ? ".exe" : ""),
);
it.skipIf(!existsSync(binary))(
  "headless bridge uses actual Rust scheduling and fences ownership on scoped shutdown",
  () =>
    withDatabase("inyosira-real-bridge-", async (path) => {
      vi.stubEnv("BIGBUD_THREAD_ORGANIZATION_BINARY", binary);
      const runtime = createRuntime(path);
      const threadId = ThreadId.makeUnsafe("bridge-thread");
      try {
        const engine = await engineFor(runtime);
        for (const command of createCommands(ProjectId.makeUnsafe("bridge-project"), [threadId]))
          await runtime.runPromise(engine.dispatch(command));
        const backend: typeof BackendInstance.Service = {
          nonce: "bridge-test",
          pid: process.pid,
          startedAt: null,
          hostname: "fixture",
          machineId: null,
          stateDir: path,
          lockPath: path + ".lock",
          assertHeld: async () => {},
          classifyOwner: () => "dead",
        };
        const bridge = await runtime.runPromise(
          makeOrganizationBridge.pipe(Effect.provideService(BackendInstance, backend)),
        );
        // The existing dev artifact is selected without any Electron window or delivery-enable gate.
        const fiber = runtime.runFork(
          Effect.scoped(bridge.run()).pipe(Effect.tapCause((cause) => Effect.logError(cause))),
        );
        try {
          await expect
            .poll(
              () =>
                runtime.runPromise(
                  Effect.gen(function* () {
                    return organizationOwner(yield* SqlClient.SqlClient)?.active;
                  }),
                ),
              { timeout: 10000 },
            )
            .toBe(true);
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe("bridge-request"),
              threadId,
              activity: {
                id: EventId.makeUnsafe("bridge-approval"),
                kind: "approval.requested",
                turnId: null,
                tone: "info",
                summary: "Approval",
                createdAt: new Date().toISOString(),
                payload: { requestId: "bridge-request-id", requestKind: "command" },
              },
              createdAt: new Date().toISOString(),
            }),
          );
          await expect
            .poll(
              () =>
                runtime.runPromise(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    const [row] = yield* sql<{
                      state: string;
                    }>`SELECT organization_state AS state FROM projection_threads WHERE thread_id = ${threadId}`;
                    return row?.state;
                  }),
                ),
              { timeout: 10000 },
            )
            .toBe("needs-you");
        } finally {
          await runtime.runPromise(Fiber.interrupt(fiber));
        }
        expect(
          await runtime.runPromise(
            Effect.gen(function* () {
              return organizationOwner(yield* SqlClient.SqlClient);
            }),
          ),
        ).toBeUndefined();
      } finally {
        await runtime.dispose();
        vi.unstubAllEnvs();
      }
    }),
  30000,
);
