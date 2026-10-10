import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { ThreadId, MessageId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { startOwnedV2SshProcess, v2SshBootstrapProgram } from "./ServerManager.ssh.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary)(
  "protected fake SSH forwards actual pinned-native text-only coding and proves only exact native child exit",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    await writeFile(
      path.join(fixture.profile, ".bigbud-opencode-v2"),
      "bigbud-opencode-v2-owned-v1\n",
      { mode: 0o600 },
    );
    const brokerProfile = `${fixture.profile}-broker`;
    await mkdir(brokerProfile, { mode: 0o700 });
    const coding = await makeV2CodingTransport(brokerProfile);
    await writeFile(path.join(fixture.workspace, "code.txt"), "old TARGET tail");
    await writeFile(path.join(fixture.workspace, "media.txt"), "remote attachment");
    fixture.state.tool = "bigbud_edit";
    fixture.state.input = { path: "code.txt", oldText: "TARGET", newText: "SSH $& literal" };
    const agent = await makeV2RemoteAgentFixture(fixture.workspace, brokerProfile);
    const program = await v2SshBootstrapProgram();
    const invocations: string[][] = [];
    const fakeSsh = ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      invocations.push(args);
      if (!args.includes("-N"))
        return spawn(process.execPath, ["--input-type=module", "-e", program], options);
      return spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./ServerManager.ssh.tunnel.fixture.mjs", import.meta.url)),
          args[args.indexOf("-L") + 1]!,
          args[args.indexOf("-R") + 1]!,
        ],
        options,
      );
    }) as typeof spawn;
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 25,
      maxQueuedEvents: 128,
      maxEventBytes: 2000000,
      consumerTimeoutMs: 10000,
      start: (config) =>
        startOwnedV2SshProcess(config, { protectedBootstrapConformance: true, spawn: fakeSsh }),
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            yield* Effect.promise(async () => {
              const events: ProviderRuntimeEvent[] = [];
              const options = {
                manager,
                journal,
                codingBridge: coding.bridge,
                config: {
                  binaryPath: binary!,
                  profileRoot: fixture.profile,
                  runtimeTargetId: "local",
                  codingEndpoint: coding.endpoint,
                },
                enableLocalTools: true,
                allowLocalWorkspace: true,
                pollIntervalMs: 100,
                emit: async (event: ProviderRuntimeEvent) => {
                  events.push(event);
                },
              };
              const runtime = new OpencodeV2Runtime({
                ...options,
                prepareSession: makeV2TargetPreparation(
                  options,
                  brokerProfile,
                  async () => agent.client,
                ),
              });
              const threadId = ThreadId.makeUnsafe("ssh-forwarded-coding"),
                target = "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key&transport=agent";
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              try {
                await runtime.start({
                  threadId,
                  cwd: fixture.workspace,
                  providerRuntimeExecutionTargetId: target,
                  workspaceExecutionTargetId: target,
                  modelSelection,
                  runtimeMode: "approval-required",
                });
                const owner = runtime.get(threadId);
                expect(owner.lease.process.hasExited!()).toBe(false);
                await runtime.send({
                  threadId,
                  modelSelection,
                  requestMessageId: MessageId.makeUnsafe("ssh-media"),
                  input: "synthetic SSH action",
                });
                await expect
                  .poll(
                    () =>
                      events.find(
                        (event) =>
                          event.type === "request.opened" &&
                          event.requestId?.startsWith("bbv2-code:"),
                      ),
                    { timeout: 15000 },
                  )
                  .toBeDefined();
                const approval = events.find(
                  (event) =>
                    event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
                )!;
                await runtime.respondPermission(threadId, approval.requestId!, "accept");
                await expect
                  .poll(() => events.some((event) => event.type === "turn.completed"), {
                    timeout: 15000,
                  })
                  .toBe(true);
                expect(await readFile(path.join(fixture.workspace, "code.txt"), "utf8")).toBe(
                  "old SSH $& literal tail",
                );
                expect(invocations[1]).toContain("-R");
                expect(invocations[1]).toContain("ExitOnForwardFailure=yes");
                expect(JSON.stringify(invocations)).not.toContain(coding.endpoint.token);
                await runtime.stop(threadId);
                await expect.poll(() => owner.lease.process.hasExited!()).toBe(true);
                await expect(
                  readFile(
                    path.join(
                      fixture.profile,
                      "config",
                      "opencode",
                      "plugins",
                      "bigbud-coding-owned.js",
                    ),
                  ),
                ).rejects.toThrow();
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
      await rm(brokerProfile, { recursive: true, force: true });
    }
  },
  60000,
);
