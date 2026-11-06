import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
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
import { organizationStatus } from "./organizationStatus.ts";

const binary = resolve(
  import.meta.dirname,
  "../../../../target/debug/bigbud-desktop-supervisor" +
    (process.platform === "win32" ? ".exe" : ""),
);
const threads = ["load-a", "load-b", "load-c"].map((id) => ThreadId.makeUnsafe(id));

it.skipIf(!existsSync(binary))(
  "streaming deltas and canonical commits racing observation never restart the native owner",
  () =>
    withDatabase("inyosira-bridge-load-", async (path) => {
      vi.stubEnv("BIGBUD_THREAD_ORGANIZATION_BINARY", binary);
      const runtime = createRuntime(path);
      try {
        const engine = await engineFor(runtime);
        for (const command of createCommands(ProjectId.makeUnsafe("load-project"), threads))
          await runtime.runPromise(engine.dispatch(command));
        const backend: typeof BackendInstance.Service = {
          nonce: "bridge-load",
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
        const fiber = runtime.runFork(Effect.scoped(bridge.run()));
        const owner = () =>
          runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return { owner: organizationOwner(sql), status: organizationStatus(sql).state };
            }),
          );
        try {
          await expect
            .poll(async () => (await owner()).owner?.active, { timeout: 10000 })
            .toBe(true);
          const live = (await owner()).owner!;
          for (let index = 0; index < 2100; index++) {
            const threadId = threads[index % 3]!;
            const at = new Date().toISOString();
            await runtime.runPromise(
              engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: CommandId.makeUnsafe(`delta-${index}`),
                threadId,
                messageId: MessageId.makeUnsafe(`message-${threadId}`),
                delta: "x",
                createdAt: at,
              }),
            );
            // Canonical organisation facts commit between observation frontier reads (C1).
            if (index % 150 === 0) {
              const kind = index % 300 === 0 ? "approval.requested" : "approval.resolved";
              await runtime.runPromise(
                engine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.makeUnsafe(`activity-${index}`),
                  threadId,
                  activity: {
                    id: EventId.makeUnsafe(`activity-${index}`),
                    kind,
                    turnId: null,
                    tone: "info",
                    summary: kind,
                    createdAt: at,
                    payload: {
                      requestId: `request-${index - (index % 300)}`,
                      requestKind: "command",
                    },
                  },
                  createdAt: at,
                }),
              );
            }
          }
          // Let several observation passes, heartbeats and decisions run after the burst.
          await new Promise((done) => setTimeout(done, 2500));
          const after = await owner();
          expect(after.owner).toBe(live);
          expect(after.owner?.active).toBe(true);
          expect(after.status).toBe("healthy");
          expect(fiber.pollUnsafe()).toBeUndefined();
          // Observation still converged: every thread's facts were republished after the burst.
          for (const threadId of threads)
            expect(after.owner?.rows.get(threadId)?.factVersion).toBeGreaterThan(0);
        } finally {
          await runtime.runPromise(Fiber.interrupt(fiber));
        }
      } finally {
        await runtime.dispose();
        vi.unstubAllEnvs();
      }
    }),
  120000,
);
