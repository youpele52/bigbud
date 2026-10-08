import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
  "actual pinned native remains owned/accepted after only its API tunnel dies, until exact bootstrap exit",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    await writeFile(
      path.join(fixture.profile, ".bigbud-opencode-v2"),
      "bigbud-opencode-v2-owned-v1\n",
      { mode: 0o600 },
    );
    const coding = await makeV2CodingTransport(fixture.profile);
    await writeFile(path.join(fixture.workspace, "code.txt"), "TARGET");
    fixture.state.tool = "bigbud_edit";
    fixture.state.input = { path: "code.txt", oldText: "TARGET", newText: "never approve" };
    const agent = await makeV2RemoteAgentFixture(fixture.workspace, fixture.profile);
    const program = await v2SshBootstrapProgram();
    const children: ReturnType<typeof spawn>[] = [];
    const fakeSsh = ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = args.includes("-N")
        ? spawn(
            process.execPath,
            [
              fileURLToPath(new URL("./ServerManager.ssh.tunnel.fixture.mjs", import.meta.url)),
              args[args.indexOf("-L") + 1]!,
              args[args.indexOf("-R") + 1]!,
            ],
            options,
          )
        : spawn(process.execPath, ["--input-type=module", "-e", program], options);
      children.push(child);
      return child;
    }) as typeof spawn;
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 2,
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
                  fixture.profile,
                  async () => agent.client,
                ),
              });
              const threadId = ThreadId.makeUnsafe("ssh-tunnel-loss"),
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
                await runtime.send({
                  threadId,
                  modelSelection,
                  requestMessageId: MessageId.makeUnsafe("ssh-loss-message"),
                  input: "pending real native coding",
                });
                const owner = runtime.get(threadId);
                await expect
                  .poll(
                    () =>
                      events.some(
                        (event) =>
                          event.type === "request.opened" &&
                          event.requestId?.startsWith("bbv2-code:"),
                      ),
                    { timeout: 15000 },
                  )
                  .toBe(true);
                children[1]!.kill("SIGKILL");
                await expect.poll(() => owner.stopped).toBe(true);
                await owner.operation;
                expect(children[0]!.exitCode).toBe(null);
                expect(owner.lease.process.hasExited!()).toBe(false);
                expect(owner.row?.state).toBe("accepted");
                expect(
                  events.some(
                    (event) => event.type === "turn.aborted" || event.type === "session.exited",
                  ),
                ).toBe(false);
                const remoteConfig = {
                  ...options.config,
                  runtimeTargetId: target,
                  workspaceRoot: fixture.workspace,
                };
                await expect(manager.acquire(remoteConfig)).rejects.toThrow("closing");
                expect(children).toHaveLength(2);
                await expect(runtime.stop(threadId)).rejects.toThrow("unconfirmed");
                await expect.poll(() => owner.lease.process.hasExited!()).toBe(true);
                await expect.poll(() => owner.row?.state).toBe("terminal");
                expect(owner.row?.terminalOutcome).toBe("interrupted");
                expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
                const successor = await manager.acquire(remoteConfig);
                expect(successor.generation).toBeGreaterThan(owner.lease.generation);
                await successor.release();
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
  60000,
);
