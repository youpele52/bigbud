import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Ref } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";

import { withCursorAcpRuntime } from "../provider/acp/CursorAcpSupport.ts";
import { makeDevinAcpRuntime } from "../provider/acp/DevinAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";
import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionShellRunner } from "../ssh/sshShellRunner.production.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceAcpBridge } from "./remoteWorkspaceAcpBridge.ts";
import { makeProductionAcpWorkspace } from "./remoteWorkspaceAcpBridge.production.ts";

// W2 T-shell real ACP session: a logged-in Cursor CLI on this host runs in ACP mode against
// the production owner bridge for a disposable remote sshd. `cwd` is the remote workspace root
// and must hold `acp-input.txt` with the token from BIGBUD_TEST_ACP_TOKEN.
// BIGBUD_TEST_ACP_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/t-acp/ws","remoteBinary":"/unused"}'
// BIGBUD_TEST_ACP_BINARY=/path/to/cursor-agent (or devin), BIGBUD_TEST_ACP_PROVIDER=cursor|devin
const external = readExternalV2Target(process.env.BIGBUD_TEST_ACP_EXTERNAL_TARGET);
const cursorBinary = process.env.BIGBUD_TEST_ACP_BINARY;
const provider = process.env.BIGBUD_TEST_ACP_PROVIDER === "devin" ? "devin" : "cursor";
const token = process.env.BIGBUD_TEST_ACP_TOKEN ?? "";

it.skipIf(external === undefined || !cursorBinary || !token)(
  "runs a real Cursor ACP session whose file and terminal requests go through the production owner",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor, cwd: root } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const live = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const owner = () => live;
      const production = makeProductionAcpWorkspace({
        targetId: descriptor.targetId,
        workspaceRoot: root,
        owner,
      });
      const workspaceTarget = {
        location: "remote",
        executionTargetId: descriptor.targetId,
        cwd: root,
      } as WorkspaceTarget;
      const bridge = await createRemoteWorkspaceAcpBridge({
        workspaceTarget,
        ptyResolver: undefined,
        prefix: "bigbud-acp-live-",
        readmeLines: ["The project files live on the remote host; use the ACP file tools."],
        ownerSelected: true,
        sessionFsOwner: production.sessionFsOwner,
        acpTerminal: {
          owner: production.terminalOwner,
          producer: production.producer,
          threadId: "thread-acp-live",
          sessionEpoch: 0,
        },
      });
      const calls: string[] = [];
      const failures: string[] = [];
      const observed = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
        // `andThen` keeps the handler's own reply (a `tap` here would answer `undefined`).
        Effect.andThen(
          Effect.sync(() => {
            calls.push(name);
            console.info(
              `ACP call ${new Date().toISOString().slice(11, 23)} ${name.slice(0, 200)}`,
            );
          }),
          () =>
            Effect.tapError(effect, (error) =>
              Effect.sync(() => {
                failures.push(`${name}: ${String((error as Error).message ?? error)}`);
                console.info(
                  `ACP fail ${name.slice(0, 80)}: ${String((error as Error).message ?? error)}`,
                );
              }),
            ),
        );
      try {
        const reply = await Effect.runPromise(
          Effect.gen(function* () {
            const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const common = {
              childProcessSpawner,
              cwd: bridge.cwd,
              clientCapabilities: bridge.clientCapabilities,
              clientInfo: { name: "bigbud-acp-live", version: "0.0.0" },
              // Raw frames for fs/terminal traffic, to diagnose agent-side handling.
              protocolLogging: {
                logIncoming: true,
                logOutgoing: true,
                logger: (event: { direction: string; stage: string; payload: unknown }) =>
                  Effect.sync(() => {
                    const raw = typeof event.payload === "string" ? event.payload : "";
                    if (event.stage === "raw" && /"id":"[0-9a-f-]{36}","error"/.test(raw))
                      console.info(`ACP ${event.direction}: ${raw.slice(0, 300)}`);
                  }),
              },
            };
            const run = <A, E>(
              body: (runtime: AcpSessionRuntimeShape) => Effect.Effect<A, E>,
            ): Effect.Effect<A, unknown> =>
              provider === "devin"
                ? Effect.scoped(
                    Effect.flatMap(
                      makeDevinAcpRuntime({
                        ...common,
                        devinSettings: { binaryPath: cursorBinary! },
                      }),
                      body,
                    ),
                  )
                : withCursorAcpRuntime(
                    { ...common, cursorSettings: { binaryPath: cursorBinary!, apiEndpoint: "" } },
                    body,
                  );
            return yield* run((runtime) =>
              Effect.gen(function* () {
                const text = yield* Ref.make("");
                // Record every client callback the agent makes, then delegate to the bridge.
                const recorded = new Proxy(runtime, {
                  get: (target, name: string) => {
                    const value = Reflect.get(target, name) as unknown;
                    if (!name.startsWith("handle") || typeof value !== "function") return value;
                    return (handler: (request: unknown) => Effect.Effect<unknown, unknown>) =>
                      (value as (h: typeof handler) => Effect.Effect<void>)((request) =>
                        observed(
                          `${name} ${JSON.stringify(request).slice(0, 240)}`,
                          Effect.tap(handler(request), (reply) =>
                            Effect.sync(() => {
                              const line = `  -> ${(JSON.stringify(reply) ?? "(void)").slice(0, 200)}`;
                              calls.push(line);
                              console.info(
                                `ACP reply ${new Date().toISOString().slice(11, 23)} ${line}`,
                              );
                            }),
                          ),
                        ),
                      );
                  },
                });
                yield* bridge.registerHandlers(recorded);
                yield* runtime.handleRequestPermission((request) =>
                  Effect.succeed({
                    outcome: {
                      outcome: "selected" as const,
                      optionId:
                        request.options.find((option) => option.kind.startsWith("allow"))
                          ?.optionId ?? request.options[0]!.optionId,
                    },
                  }),
                );
                yield* runtime.handleSessionUpdate((notification) => {
                  const update = notification.update;
                  if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
                  const content = update.content;
                  return content.type === "text"
                    ? Ref.update(text, (current) => current + content.text)
                    : Effect.void;
                });
                const started = yield* runtime.start();
                bridge.bindCaller?.(started.sessionId);
                // Bounded inside the scope, so a hung agent is still torn down.
                yield* runtime
                  .prompt({
                    prompt: [
                      {
                        type: "text",
                        text: [
                          `The project is at ${root} on a remote host; use your ACP file and terminal tools for it.`,
                          `1. Read the file ${root}/acp-input.txt.`,
                          `2. Run the terminal command \`ls\` with working directory ${root}.`,
                          `3. Write a file ${root}/acp-output.txt whose only content is that file's token followed by "-ok".`,
                          "4. Reply with only the token you read.",
                        ].join("\n"),
                      },
                    ],
                  })
                  .pipe(Effect.timeout("150 seconds"));
                return yield* Ref.get(text);
              }),
            );
          }).pipe(Effect.provide(NodeServices.layer)),
        );
        console.info(`ACP client callbacks: ${JSON.stringify(calls)}`);
        console.info(`ACP client failures: ${JSON.stringify(failures)}`);
        console.info(`agent reply: ${reply.trim().slice(0, 200)}`);
        expect(calls.some((call) => call.startsWith("handleReadTextFile"))).toBe(true);
        expect(reply).toContain(token);
        const check = await Effect.runPromise(
          makeProductionShellRunner(descriptor.targetId, owner).run({
            threadId: "acp-live-check",
            cwd: root,
            command: "cat acp-output.txt 2>/dev/null || echo missing",
          }),
        );
        console.info(`remote acp-output.txt: ${check.output.trim()}`);
        expect(check.output.trim()).toBe(`${token}-ok`);
      } finally {
        await bridge.cleanup();
      }
    });
  },
  240_000,
);
