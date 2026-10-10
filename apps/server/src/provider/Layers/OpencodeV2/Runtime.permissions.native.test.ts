import { Effect, Layer } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { v2ResumeCursor } from "./Runtime.sessions.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;

it.skipIf(!binary)(
  "exact native reject closes every pending request and saved grants cannot silently broaden resumed owned policy",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 25,
      maxQueuedEvents: 128,
      maxEventBytes: 2_000_000,
      consumerTimeoutMs: 15000,
    });
    try {
      // Native saved grants are project-scoped: copy existing local history into the disposable workspace.
      // No checkout, staging, new commit or network/remote host is involved.
      const git = promisify(execFile);
      const repository = (await git("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
      await git("git", ["init", "--quiet", fixture.workspace]);
      await git("git", [
        "-C",
        fixture.workspace,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        repository,
        "HEAD:refs/heads/main",
      ]);
      await git("git", ["-C", fixture.workspace, "symbolic-ref", "HEAD", "refs/heads/main"]);
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
              allowLocalWorkspace: true,
              enableLocalTools: true,
              pollIntervalMs: 100,
            });
            yield* Effect.promise(async () => {
              try {
                const start = {
                  threadId: ThreadId.makeUnsafe("native-permission-policy"),
                  cwd: fixture.workspace,
                  runtimeMode: "approval-required" as const,
                  modelSelection: {
                    provider: "opencodeV2" as const,
                    subProviderID: "bigbud-v2-fixture",
                    model: "synthetic-model",
                  },
                };
                await runtime.start(start);
                const owner = runtime.get(start.threadId),
                  client = owner.lease.process.client;
                const first = await client.permission.create({
                  sessionID: owner.native.id,
                  action: "shell",
                  resources: ["echo first"],
                });
                const second = await client.permission.create({
                  sessionID: owner.native.id,
                  action: "shell",
                  resources: ["echo second"],
                });
                expect(first.effect).toBe("ask");
                expect(second.effect).toBe("ask");
                expect(
                  (await pendingV2Interactions(owner)).filter(
                    (event) => event.type === "request.opened",
                  ),
                ).toHaveLength(2);
                await runtime.respondPermission(start.threadId, first.id, "decline");
                expect(await client.permission.list({ sessionID: owner.native.id })).toEqual([]);
                const invalidated = await pendingV2Interactions(owner);
                expect(
                  invalidated.some(
                    (event) => event.type === "request.resolved" && event.requestId === second.id,
                  ),
                ).toBe(true);
                await expect(
                  runtime.respondPermission(start.threadId, second.id, "accept"),
                ).rejects.toThrow();
                expect(
                  await client.permission.saved.list({ projectID: owner.native.projectID }),
                ).toEqual([]);

                const once = await client.permission.create({
                  sessionID: owner.native.id,
                  action: "shell",
                  resources: ["echo once"],
                  save: ["*"],
                });
                await runtime.respondPermission(start.threadId, once.id, "accept");
                expect(
                  await client.permission.saved.list({ projectID: owner.native.projectID }),
                ).toEqual([]); // UI must never save grants.

                // Seed a native saved approval only inside this disposable profile; bigbud never offers "always".
                fixture.state.tool = "shell";
                fixture.state.input = {
                  command: "printf qualification",
                  description: "Disposable grant seed",
                  timeout: 5000,
                };
                await runtime.send({
                  threadId: start.threadId,
                  requestMessageId: MessageId.makeUnsafe("seed-native-grant"),
                  input: "seed disposable native grant",
                });
                await expect
                  .poll(
                    async () =>
                      (await client.permission.list({ sessionID: owner.native.id })).length,
                    { timeout: 15000 },
                  )
                  .toBeGreaterThan(0);
                const seed = (await client.permission.list({ sessionID: owner.native.id }))[0]!;
                await client.permission.reply({
                  sessionID: owner.native.id,
                  requestID: seed.id,
                  decision: "always",
                });
                await expect.poll(() => owner.terminalDelivered, { timeout: 15000 }).toBe(true);
                await expect
                  .poll(
                    async () =>
                      (await client.permission.saved.list({ projectID: owner.native.projectID }))
                        .length,
                    { timeout: 4000 },
                  )
                  .toBeGreaterThan(0);
                const grants = await client.permission.saved.list({
                  projectID: owner.native.projectID,
                });
                // Native rules alone still broaden ask -> allow; prove the provider gate, not a claimed upstream fix.
                expect(
                  (
                    await client.permission.create({
                      sessionID: owner.native.id,
                      action: "shell",
                      resources: ["printf must-ask"],
                    })
                  ).effect,
                ).toBe("allow");
                const generated = fixture.state.modelRequests;
                await expect(
                  runtime.send({
                    threadId: start.threadId,
                    requestMessageId: MessageId.makeUnsafe("blocked-saved-grants"),
                    input: "must not dispatch",
                  }),
                ).rejects.toThrow("saved native approvals");
                expect(fixture.state.modelRequests).toBe(generated);
                expect(() => runtime.mutations.assertSafe()).not.toThrow();
                const cursor = v2ResumeCursor(owner);
                const observer = await manager.acquire(runtime.options.config);
                try {
                  await runtime.stop(start.threadId);
                  await expect(runtime.start({ ...start, resumeCursor: cursor })).rejects.toThrow(
                    "saved native approvals",
                  );
                  expect(await client.session.get({ sessionID: owner.native.id })).toMatchObject({
                    id: owner.native.id,
                  });
                  // Explicit removal is a test-only operator action, never an application side effect.
                  for (const grant of grants)
                    await client.permission.saved.remove({ id: grant.id });
                  await runtime.start({ ...start, resumeCursor: cursor });
                } finally {
                  await observer.release();
                }
                const resumed = runtime.get(start.threadId);
                expect(resumed.native.id).toBe(owner.native.id);
                const evaluated = await resumed.lease.process.client.permission.create({
                  sessionID: resumed.native.id,
                  action: "shell",
                  resources: ["printf must-ask"],
                });
                expect(evaluated.effect).toBe("ask");
                await runtime.respondPermission(start.threadId, evaluated.id, "decline");
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
