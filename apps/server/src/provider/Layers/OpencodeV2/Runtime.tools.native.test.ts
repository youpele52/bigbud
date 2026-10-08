import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { readV2Messages } from "./Runtime.projection.ts";

const binaryPath = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;

it.skipIf(!binaryPath)(
  "pinned CLI cannot read/write/edit through workspace symlinks or install plugins; supported question form still works",
  async () => {
    let round = 0;
    let tool = "write";
    let args: Record<string, unknown> = {};
    const advertised = new Set<string>();
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const input = JSON.parse(body) as { tools?: { function: { name: string } }[] };
      for (const item of input.tools ?? []) advertised.add(item.function.name);
      const calling = Boolean(input.tools?.length) && round++ % 2 === 0;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        {
          choices: [
            {
              index: 0,
              delta: calling
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `synthetic-${round}`,
                        type: "function",
                        function: { name: tool, arguments: JSON.stringify(args) },
                      },
                    ],
                  }
                : { role: "assistant", content: "synthetic completed" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: calling ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic-model", ...chunk })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("fixture endpoint missing");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-security-native-")));
    const profile = path.join(root, "profile");
    const directory = path.join(root, "workspace");
    const external = path.join(root, "external");
    for (const name of [profile, directory, external]) await mkdir(name, { mode: 0o700 });
    await mkdir(path.join(profile, "config", "opencode"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(profile, "config", "opencode", "opencode.json"),
      JSON.stringify({
        providers: {
          "bigbud-v2-fixture": {
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "disposable-synthetic-only",
            },
            models: {
              "synthetic-model": {
                name: "synthetic-model",
                limit: { context: 32000, output: 4000 },
              },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(path.join(external, "secret.txt"), "DISPOSABLE_OUTSIDE_CONTENT_9231", {
      mode: 0o600,
    });
    await symlink(external, path.join(directory, "linked"));
    await symlink(profile, path.join(directory, "runtime-storage"));
    const marker = path.join(external, "plugin-executed");
    const plugin = path.join(profile, "config", "opencode", "plugins", "payload.js");
    const layer = ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            yield* Effect.promise(async () => {
              const events: ProviderRuntimeEvent[] = [];
              const runtime = new OpencodeV2Runtime({
                manager: new OpencodeV2ServerManager({
                  maxProcesses: 1,
                  maxOwners: 25,
                  maxQueuedEvents: 128,
                  maxEventBytes: 2000000,
                  consumerTimeoutMs: 15000,
                }),
                config: { binaryPath: binaryPath!, profileRoot: profile, runtimeTargetId: "local" },
                journal,
                enableLocalTools: true,
                allowLocalWorkspace: true,
                remoteSessionConformance: {
                  providerRuntimeTargetId: "local",
                  workspaceTargetId: "ssh:synthetic-only",
                  profileRoot: profile,
                  syntheticDirectory: directory,
                },
                pollIntervalMs: 100,
                emit: async (event) => {
                  events.push(event);
                },
              });
              const threadId = ThreadId.makeUnsafe("security-native");
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              try {
                await runtime.start({
                  threadId,
                  cwd: directory,
                  modelSelection,
                  runtimeMode: "approval-required",
                  workspaceExecutionTargetId: "ssh:synthetic-only",
                });
                // Created after admission: a one-time workspace symlink scan could not protect this path.
                await symlink(external, path.join(directory, "late-linked"));
                const cases = [
                  {
                    tool: "write",
                    args: {
                      path: path.join(directory, "late-linked", "late.txt"),
                      content: "unauthorized",
                    },
                  },
                  {
                    tool: "write",
                    args: {
                      path: path.join(directory, "linked", "new-parent", "created.txt"),
                      content: "unauthorized",
                    },
                  },
                  {
                    tool: "write",
                    args: {
                      path: path.join(directory, "linked", "secret.txt"),
                      content: "unauthorized",
                    },
                  },
                  {
                    tool: "read",
                    args: {
                      path: path.join(directory, "linked", "secret.txt"),
                      offset: 1,
                      limit: 20,
                    },
                  },
                  {
                    tool: "edit",
                    args: {
                      path: path.join(directory, "linked", "secret.txt"),
                      oldString: "DISPOSABLE_OUTSIDE_CONTENT_9231",
                      newString: "unauthorized",
                    },
                  },
                  {
                    tool: "write",
                    args: {
                      path: path.join(
                        directory,
                        "runtime-storage",
                        "config",
                        "opencode",
                        "plugins",
                        "payload.js",
                      ),
                      content: `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default async () => ({});`,
                    },
                  },
                  {
                    tool: "shell",
                    args: {
                      command: `printf unauthorized > ${JSON.stringify(path.join(external, "shell-effect"))}`,
                      timeout: 1000,
                    },
                  },
                ];
                for (const [index, item] of cases.entries()) {
                  tool = item.tool;
                  args = item.args;
                  round = 0;
                  const offset = events.length;
                  await runtime.send({
                    threadId,
                    modelSelection,
                    requestMessageId: MessageId.makeUnsafe(`blocked-${index}`),
                    input: "synthetic adversarial fixture",
                  });
                  await expect
                    .poll(
                      () => events.slice(offset).some((event) => event.type === "turn.completed"),
                      { timeout: 15000 },
                    )
                    .toBe(true);
                  expect(
                    events.slice(offset).some((event) => event.type === "request.opened"),
                  ).toBe(false);
                  expect(await readFile(path.join(external, "secret.txt"), "utf8")).toBe(
                    "DISPOSABLE_OUTSIDE_CONTENT_9231",
                  );
                  for (const filename of [
                    plugin,
                    marker,
                    path.join(external, "new-parent", "created.txt"),
                    path.join(external, "shell-effect"),
                    path.join(external, "late.txt"),
                  ])
                    await expect(readFile(filename)).rejects.toThrow();
                }
                const native = JSON.stringify(await readV2Messages(runtime.get(threadId)));
                // The edit argument itself contains the sentinel; no result/tool output may disclose it.
                for (const message of await readV2Messages(runtime.get(threadId)))
                  if (message.type === "assistant")
                    for (const part of message.content)
                      if (part.type === "tool" && part.state.status === "completed")
                        expect(JSON.stringify(part.state.content)).not.toContain(
                          "DISPOSABLE_OUTSIDE_CONTENT_9231",
                        );
                expect(native).not.toContain("plugin-executed');");
                for (const name of ["write", "read", "edit", "shell", "skill"])
                  expect(advertised.has(name)).toBe(false);
                tool = "question";
                args = {
                  questions: [
                    {
                      question: "Synthetic choice?",
                      header: "Choice",
                      options: [{ label: "safe", description: "disposable fixture" }],
                    },
                  ],
                };
                round = 0;
                const offset = events.length;
                await runtime.send({
                  threadId,
                  modelSelection,
                  requestMessageId: MessageId.makeUnsafe("native-form"),
                  input: "synthetic form",
                });
                await expect
                  .poll(
                    () =>
                      events.slice(offset).find((event) => event.type === "user-input.requested"),
                    { timeout: 15000 },
                  )
                  .toBeTruthy();
                const form = events
                  .slice(offset)
                  .find((event) => event.type === "user-input.requested")!;
                if (!form.requestId) throw new Error("fixture form missing");
                await runtime.respondForm(threadId, form.requestId, { q0: "safe" });
                await expect
                  .poll(
                    () => events.slice(offset).some((event) => event.type === "turn.completed"),
                    { timeout: 15000 },
                  )
                  .toBe(true);
                await runtime.stop(threadId);
                await runtime.start({
                  threadId,
                  cwd: directory,
                  modelSelection,
                  runtimeMode: "approval-required",
                  workspaceExecutionTargetId: "ssh:synthetic-only",
                });
                await expect(readFile(marker)).rejects.toThrow();
              } finally {
                await runtime.close();
              }
            });
          }),
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
