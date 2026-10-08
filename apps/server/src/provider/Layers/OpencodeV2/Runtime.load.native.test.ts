import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
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

const binaryPath = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;

/** Native CLI concurrency against held disposable model streams, not real-provider budget approval. */
it.skipIf(!binaryPath)(
  "keeps 25 native sessions simultaneously generating, repairs every terminal, and never redispatches replay",
  async () => {
    const held: (() => void)[] = [];
    let inflight = 0;
    let maximum = 0;
    let generating = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const input = JSON.parse(body) as { stream?: boolean };
      const nativeGeneration = input.stream === true;
      if (nativeGeneration) {
        generating++;
        inflight++;
        maximum = Math.max(maximum, inflight);
      }
      const finish = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "synthetic parallel output" },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
          response.write(
            `data: ${JSON.stringify({ id: "synthetic-load", object: "chat.completion.chunk", created: 1, model: "synthetic-model", ...chunk })}\n\n`,
          );
        response.end("data: [DONE]\n\n");
        if (nativeGeneration) inflight--;
      };
      if (nativeGeneration) held.push(finish);
      else finish();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture endpoint missing");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-native-load-")));
    const workspace = path.join(root, "workspace");
    const profile = path.join(root, "profile");
    await mkdir(profile, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(path.join(profile, "config", "opencode"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(profile, "config", "opencode", "opencode.json"),
      JSON.stringify({
        providers: {
          "bigbud-load-fixture": {
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
    const layer = ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory));
    const baseline = { rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage() };
    const began = performance.now();
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
                  maxOwners: 32,
                  maxQueuedEvents: 256,
                  maxEventBytes: 2000000,
                  consumerTimeoutMs: 15000,
                }),
                config: { binaryPath: binaryPath!, profileRoot: profile, runtimeTargetId: "local" },
                journal,
                emit: async (event) => {
                  events.push(event);
                },
                pollIntervalMs: 100,
              });
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-load-fixture",
                model: "synthetic-model",
              } as const;
              const inputs = Array.from({ length: 25 }, (_, index) => ({
                threadId: ThreadId.makeUnsafe(`load-${index}`),
                requestMessageId: MessageId.makeUnsafe(`load-${index}`),
                modelSelection,
                input: `synthetic parallel request ${index}`,
              }));
              try {
                await Promise.all(
                  inputs.map((input) =>
                    runtime.start({ ...input, cwd: workspace, runtimeMode: "approval-required" }),
                  ),
                );
                expect(runtime.sessions.size).toBe(25);
                // Exclude native auxiliary auto-title generations from the held model barrier.
                for (const session of runtime.sessions.values())
                  await runtime.withSession(session.threadId, () =>
                    runtime.mutations.run(
                      session,
                      "load fixture title",
                      (signal) =>
                        session.lease.process.client.session.update(
                          { sessionID: session.native.id, title: "Synthetic load fixture" },
                          { signal },
                        ),
                      async () => false,
                    ),
                  );
                await Promise.all(inputs.map((input) => runtime.send(input)));
                await expect.poll(() => inflight, { timeout: 30000 }).toBe(25);
                expect(maximum).toBe(25);
                expect(generating).toBe(25);
                expect(events.some((event) => event.type === "turn.completed")).toBe(false);
                for (const finish of held.splice(0)) finish();
                await expect
                  .poll(() => events.filter((event) => event.type === "turn.completed").length, {
                    timeout: 30000,
                  })
                  .toBe(25);
                expect(
                  new Set(
                    events
                      .filter((event) => event.type === "turn.completed")
                      .map((event) => event.threadId),
                  ).size,
                ).toBe(25);
                expect(
                  [...runtime.sessions.values()].every(
                    (session) =>
                      session.row?.state === "terminal" &&
                      session.row.terminalOutcome === "completed",
                  ),
                ).toBe(true);
                await Promise.all(inputs.map((input) => runtime.send(input)));
                expect(generating).toBe(25);
                expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(25);
                const measurement = {
                  sessions: 25,
                  maximumSimultaneousModelStreams: maximum,
                  elapsedMs: performance.now() - began,
                  workerRssDeltaBytes: process.memoryUsage().rss - baseline.rssBytes,
                  workerCpuMicroseconds: process.cpuUsage(baseline.cpu),
                };
                const metricsPath = process.env.BIGBUD_OPENCODE_V2_TEST_METRICS;
                if (metricsPath) {
                  if (!path.isAbsolute(metricsPath))
                    throw new Error("Native fixture metrics path must be absolute.");
                  await writeFile(
                    metricsPath,
                    JSON.stringify({
                      scope: "disposable-native-simulator-test-worker-only-not-production-budget",
                      ...measurement,
                    }) + "\n",
                    { flag: "wx", mode: 0o600 },
                  );
                }
                console.info(
                  "V2 disposable native simulator measurement (test-worker/client/journal overhead only; excludes native process RSS and real model/provider budgets)",
                  JSON.stringify(measurement),
                );
              } finally {
                for (const finish of held.splice(0)) finish();
                await runtime.close();
              }
            });
          }),
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
