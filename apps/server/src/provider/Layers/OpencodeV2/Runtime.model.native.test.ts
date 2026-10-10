import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary)(
  "pinned native model/variant switch preserves session, history and original replay",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    const filename = path.join(fixture.profile, "config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(filename, "utf8"));
    config.providers["bigbud-v2-fixture"].models["second-model"] = {
      name: "second-model",
      limit: { context: 32000, output: 4000 },
      variants: [{ id: "precise", settings: { temperature: 0.1 } }],
    };
    await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 25,
      maxQueuedEvents: 128,
      maxEventBytes: 2_000_000,
      consumerTimeoutMs: 15_000,
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            const runtime = new OpencodeV2Runtime({
              manager,
              journal,
              config: {
                binaryPath: binary!,
                profileRoot: fixture.profile,
                runtimeTargetId: "local",
              },
              emit: async () => {},
              pollIntervalMs: 100,
            });
            yield* Effect.promise(async () => {
              try {
                const threadId = ThreadId.makeUnsafe("native-model-switch");
                const modelSelection = {
                  provider: "opencodeV2" as const,
                  subProviderID: "bigbud-v2-fixture",
                  model: "synthetic-model",
                };
                await runtime.start({
                  threadId,
                  cwd: fixture.workspace,
                  modelSelection,
                  runtimeMode: "approval-required",
                });
                const original = {
                  threadId,
                  modelSelection,
                  requestMessageId: MessageId.makeUnsafe("native-model-first"),
                  input: "first",
                };
                const first = await runtime.send(original);
                await expect
                  .poll(() => runtime.get(threadId).terminalDelivered, { timeout: 15000 })
                  .toBe(true);
                const nativeId = runtime.get(threadId).native.id;
                await runtime.send({
                  ...original,
                  requestMessageId: MessageId.makeUnsafe("native-model-second"),
                  input: "second",
                  modelSelection: {
                    ...modelSelection,
                    model: "second-model",
                    options: { variant: "precise" },
                  },
                });
                await expect
                  .poll(() => runtime.get(threadId).terminalDelivered, { timeout: 15000 })
                  .toBe(true);
                const owner = runtime.get(threadId);
                const native = await owner.lease.process.client.session.get({
                  sessionID: nativeId,
                });
                expect(native.id).toBe(owner.native.id);
                expect(native.model).toEqual({
                  providerID: "bigbud-v2-fixture",
                  id: "second-model",
                  variant: "precise",
                });
                const calls = fixture.state.modelRequests;
                expect((await runtime.send(original)).turnId).toBe(first.turnId);
                expect(fixture.state.modelRequests).toBe(calls);
                const messages = await owner.lease.process.client.message.list({
                  sessionID: nativeId,
                });
                expect(messages.data.filter((message) => message.type === "user")).toHaveLength(2);
              } finally {
                await runtime.close();
              }
            });
          }).pipe(
            Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
          ),
        ),
      );
    } finally {
      await manager.close();
      await fixture.close();
    }
  },
  60000,
);
