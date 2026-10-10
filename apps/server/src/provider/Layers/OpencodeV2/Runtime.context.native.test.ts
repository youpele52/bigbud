import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { v2InstructionEntries, v2InstructionRevision } from "./Runtime.instructions.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;

it.skipIf(!binary)(
  "pinned native instructions survive process restart, refresh only for new admissions and cancel unsupported forms",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    fixture.state.textOnlyDelegated = true;
    const runtimes: OpencodeV2Runtime[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            const createRuntime = () => {
              const runtime = new OpencodeV2Runtime({
                manager: new OpencodeV2ServerManager({
                  maxProcesses: 1,
                  maxOwners: 25,
                  maxQueuedEvents: 128,
                  maxEventBytes: 2_000_000,
                  consumerTimeoutMs: 15_000,
                }),
                journal,
                config: {
                  binaryPath: binary!,
                  profileRoot: fixture.profile,
                  runtimeTargetId: "local",
                },
                emit: async () => {},
                pollIntervalMs: 100,
                allowLocalWorkspace: true,
                enableLocalTools: true,
              });
              runtimes.push(runtime);
              return runtime;
            };
            yield* Effect.promise(async () => {
              const start = {
                threadId: ThreadId.makeUnsafe("native-instruction-restart"),
                cwd: fixture.workspace,
                modelSelection: {
                  provider: "opencodeV2" as const,
                  subProviderID: "bigbud-v2-fixture",
                  model: "synthetic-model",
                },
                runtimeMode: "approval-required" as const,
              };
              const original = {
                threadId: start.threadId,
                modelSelection: start.modelSelection,
                requestMessageId: MessageId.makeUnsafe("native-instruction-first"),
                input: "delegated_thread_provenance: synthetic instruction qualification",
              };
              const firstRuntime = createRuntime();
              await firstRuntime.start(start);
              const firstOwner = firstRuntime.get(start.threadId);
              const client = firstOwner.lease.process.client;
              const userEntry = { key: "user.guidance", value: "preserve native user guidance" };
              await client.session.instructions.entry.put({
                sessionID: firstOwner.native.id,
                ...userEntry,
              });
              const first = await firstRuntime.send(original);
              await expect.poll(() => firstOwner.terminalDelivered, { timeout: 15000 }).toBe(true);
              const messages = await client.message.list({ sessionID: firstOwner.native.id });
              expect(messages.data.find((item) => item.type === "user")).toMatchObject({
                metadata: {
                  bigbud_instruction_revision: v2InstructionRevision(
                    v2InstructionEntries(firstOwner),
                  ),
                },
              });
              const nativeId = firstOwner.native.id;
              await firstRuntime.close();
              expect(firstOwner.lease.process.hasExited?.()).toBe(true);

              const restarted = createRuntime();
              await restarted.start({ ...start, resumeCursor: first.resumeCursor });
              const owner = restarted.get(start.threadId);
              expect(owner.native.id).toBe(nativeId);
              const entries = owner.lease.process.client.session.instructions.entry;
              expect(await entries.list({ sessionID: nativeId })).toContainEqual(userEntry);
              await entries.put({
                sessionID: nativeId,
                key: "bigbud.preview.v1.access",
                value: "obsolete guidance",
              });
              const calls = fixture.state.modelRequests;
              expect((await restarted.send(original)).turnId).toBe(first.turnId);
              expect(fixture.state.modelRequests).toBe(calls);
              expect(await entries.list({ sessionID: nativeId })).toContainEqual({
                key: "bigbud.preview.v1.access",
                value: "obsolete guidance",
              });
              await restarted.send({
                ...original,
                requestMessageId: MessageId.makeUnsafe("native-instruction-next"),
                input: `${original.input} next`,
              });
              await expect.poll(() => owner.terminalDelivered, { timeout: 15000 }).toBe(true);
              const refreshed = await entries.list({ sessionID: nativeId });
              expect(refreshed).toContainEqual(userEntry);
              expect(refreshed).toContainEqual(v2InstructionEntries(owner)[0]);

              const form = await owner.lease.process.client.session.form.create({
                sessionID: nativeId,
                title: "Unsupported hidden native form",
                fields: [{ key: "secret", type: "string", hidden: true }],
              });
              await restarted.withSession(start.threadId, () => pendingV2Interactions(owner));
              const cancelled = await owner.lease.process.client.session.form.get({
                sessionID: nativeId,
                formID: form.id,
              });
              expect(cancelled.state.status).toBe("cancelled");
              expect(
                await owner.lease.process.client.session.form.list({ sessionID: nativeId }),
              ).toEqual([]);
            });
          }).pipe(
            Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
          ),
        ),
      );
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      await fixture.close();
    }
  },
  60000,
);
