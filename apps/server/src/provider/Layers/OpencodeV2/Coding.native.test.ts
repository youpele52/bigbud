import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary)(
  "pinned 2.0.26 plugin performs actual once-approved file write/edit/read/check and rejects declined writes",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    const coding = await makeV2CodingTransport(fixture.profile);
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
            yield* Effect.promise(async () => {
              const events: ProviderRuntimeEvent[] = [];
              const runtime = new OpencodeV2Runtime({
                manager,
                journal,
                config: {
                  binaryPath: binary!,
                  profileRoot: fixture.profile,
                  runtimeTargetId: "local",
                },
                codingBridge: coding.bridge,
                enableLocalTools: true,
                allowLocalWorkspace: true,
                pollIntervalMs: 100,
                emit: async (event) => {
                  events.push(event);
                },
              });
              const threadId = ThreadId.makeUnsafe("coding-native");
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              try {
                await runtime.start({
                  threadId,
                  cwd: fixture.workspace,
                  modelSelection,
                  runtimeMode: "approval-required",
                });
                for (const [index, action] of [
                  {
                    tool: "bigbud_write",
                    input: { path: "main.py", content: "value = 1\n" },
                    approve: true,
                  },
                  {
                    tool: "bigbud_edit",
                    input: { path: "main.py", oldText: "1", newText: "2" },
                    approve: true,
                  },
                  { tool: "bigbud_read", input: { path: "main.py" }, approve: true },
                  { tool: "bigbud_list", input: { path: "." }, approve: true },
                  { tool: "bigbud_skill", input: { path: "example" }, approve: true },
                  { tool: "bigbud_check", input: { path: "main.py" }, approve: true },
                  {
                    tool: "bigbud_write",
                    input: { path: "declined.py", content: "wrong" },
                    approve: false,
                  },
                ].entries()) {
                  fixture.state.tool = action.tool;
                  fixture.state.input = action.input;
                  fixture.state.round = 0;
                  const offset = events.length;
                  await runtime.send({
                    threadId,
                    modelSelection,
                    requestMessageId: MessageId.makeUnsafe(`coding-${index}`),
                    input: "synthetic coding action",
                  });
                  await expect
                    .poll(
                      () =>
                        events
                          .slice(offset)
                          .find(
                            (event) =>
                              event.type === "request.opened" &&
                              event.requestId?.startsWith("bbv2-code:"),
                          ),
                      { timeout: 15_000 },
                    )
                    .toBeDefined();
                  const request = events
                    .slice(offset)
                    .find(
                      (event) =>
                        event.type === "request.opened" &&
                        event.requestId?.startsWith("bbv2-code:"),
                    )!;
                  await runtime.respondPermission(
                    threadId,
                    request.requestId!,
                    action.approve ? "accept" : "decline",
                  );
                  await expect
                    .poll(
                      () => events.slice(offset).some((event) => event.type === "turn.completed"),
                      { timeout: 15_000 },
                    )
                    .toBe(true);
                }
                expect(await readFile(path.join(fixture.workspace, "main.py"), "utf8")).toBe(
                  "value = 2\n",
                );
                await expect(
                  readFile(path.join(fixture.workspace, "declined.py")),
                ).rejects.toThrow();
                expect(fixture.state.advertised.has("bigbud_write")).toBe(true);
                for (const tool of ["read", "shell", "skill"])
                  expect(fixture.state.advertised.has(tool)).toBe(true);
                for (const tool of ["subagent"])
                  expect(fixture.state.advertised.has(tool)).toBe(false);
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
      await coding.close();
      await fixture.close();
    }
  },
  60_000,
);
