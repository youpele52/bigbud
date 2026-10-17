import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import {
  makeV2SharedNativeRuntimeHarness,
  v2SharedNativePersistence,
} from "./SharedService.native.runtime.fixture.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { validateSyntheticV2Learning } from "./Runtime.learning.fixture.ts";

// Shared path: the approval-gated retail fixture's registered service, borrowed (never launched).
const binaryPath = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

/** Opt-in real CLI, synthetic loopback model only. Never discovers an existing profile/credential. */
it.skipIf(!binaryPath)(
  "executes a real isolated V2 turn through a synthetic model endpoint",
  async () => {
    let calls = 0;
    let hold = false;
    let failModel = false;
    let modelText = "safe isolated native output";
    const pending: (() => void)[] = [];
    const modelServer = createServer((request, response) => {
      request.resume();
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      calls++;
      if (failModel) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "Synthetic failure",
              type: "invalid_request_error",
              code: "synthetic",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const finish = () => {
        for (const chunk of [
          {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: "synthetic-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: modelText },
                finish_reason: null,
              },
            ],
          },
          {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: "synthetic-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (hold) pending.push(finish);
      else finish();
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    if (!address || typeof address === "string") throw new Error("Synthetic endpoint unavailable.");
    // Only the disposable provider endpoint is redirected to this test's controllable model.
    const fixture = await sharedServiceNativeFixture(binaryPath!, async (file) => {
      const config = JSON.parse(await readFile(file, "utf8"));
      config.providers["bigbud-v2-fixture"].settings.baseURL =
        `http://127.0.0.1:${address.port}/v1`;
      config.permissions = [{ action: "*", resource: "*", effect: "deny" }];
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    }).catch(async (error) => {
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      throw error;
    });
    const directory = fixture.workspace;
    const harness = await makeV2SharedNativeRuntimeHarness(fixture);
    const { manager, ...shared } = await harness.runtimeOptions();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            const events: ProviderRuntimeEvent[] = [];
            const runtime = new OpencodeV2Runtime({
              ...shared,
              manager,
              journal,
              sharedBindings: yield* OpencodeV2SharedBindings,
              emit: async (event) => {
                events.push(event);
              },
              pollIntervalMs: 100,
            });
            try {
              const threadId = ThreadId.makeUnsafe("native-synthetic-thread");
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              yield* Effect.promise(() =>
                runtime.start({
                  threadId,
                  cwd: directory,
                  runtimeMode: "approval-required",
                  modelSelection,
                }),
              );
              const input = {
                threadId,
                requestMessageId: MessageId.makeUnsafe("native-synthetic-request"),
                input: "Return synthetic output without tools",
                modelSelection,
              };
              yield* Effect.promise(() => runtime.send(input));
              yield* Effect.promise(async () => {
                try {
                  await expect
                    .poll(() => runtime.get(threadId).row?.state, { timeout: 20000 })
                    .toBe("terminal");
                } catch (error) {
                  const owner = runtime.get(threadId);
                  await pendingV2Interactions(owner).catch((error) =>
                    console.error("Synthetic interaction diagnostics", error.message),
                  );
                  await readV2Messages(owner).catch((error) =>
                    console.error("Synthetic bounded reader diagnostics", error.message),
                  );
                  const native = await owner.lease.process.client.message
                    .list({ sessionID: owner.native.id, order: "asc", limit: 100 })
                    .then((result) => {
                      console.error(
                        "Synthetic page",
                        JSON.stringify({ cursor: result.cursor, count: result.data.length }),
                      );
                      return result.data;
                    })
                    .catch((error) => {
                      console.error("Synthetic projection failure", {
                        message: error instanceof Error ? error.message : "non-Error",
                        reason: error?.reason,
                        tag: error?._tag,
                      });
                      return [];
                    });
                  console.error(
                    "Synthetic native diagnostics",
                    JSON.stringify({
                      calls,
                      status: runtime.get(threadId).session.status,
                      lastError: owner.session.lastError,
                      // oxlint-disable-next-line no-map-spread -- diagnostics copy native messages; never mutate client results
                      messages: native.map((message) => ({
                        type: message.type,
                        id: message.id,
                        metadata: message.metadata,
                        ...(message.type === "assistant"
                          ? { error: message.error, finish: message.finish, time: message.time }
                          : {}),
                        ...(message.type === "idle" ? { outcome: message.outcome } : {}),
                      })),
                    }),
                  );
                  throw error;
                }
                expect(runtime.get(threadId).row?.terminalOutcome).toBe("completed");
                expect(runtime.get(threadId).row?.finalText).toBe("safe isolated native output");
                expect(
                  (await runtime.catalog(threadId)).some(
                    (model) =>
                      model.slug === "synthetic-model" &&
                      model.subProviderID === "bigbud-v2-fixture",
                  ),
                ).toBe(true);
                expect(calls).toBeGreaterThan(0);
                const before = calls;
                await runtime.send(input);
                expect(calls).toBe(before);
                expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
                const cursor = runtime.get(threadId).session.resumeCursor;
                await runtime.stop(threadId);
                await runtime.start({
                  threadId,
                  cwd: directory,
                  runtimeMode: "approval-required",
                  modelSelection,
                  resumeCursor: cursor,
                });
                await runtime.send(input);
                expect(calls).toBe(before);
                const threads = [
                  threadId,
                  ...Array.from({ length: 24 }, (_, index) =>
                    ThreadId.makeUnsafe(`native-load-${index}`),
                  ),
                ];
                await Promise.all(
                  threads.slice(1).map((id) =>
                    runtime.start({
                      threadId: id,
                      cwd: directory,
                      runtimeMode: "approval-required",
                      modelSelection,
                    }),
                  ),
                );
                hold = true;
                try {
                  await Promise.all(
                    threads.map((id, index) =>
                      runtime.send({
                        ...input,
                        threadId: id,
                        requestMessageId: MessageId.makeUnsafe(`native-concurrent-${index}`),
                      }),
                    ),
                  );
                  await expect
                    .poll(
                      async () => {
                        const active = await runtime
                          .get(threadId)
                          .lease.process.client.session.active();
                        return threads.filter((id) => !!active[runtime.get(id).native.id]).length;
                      },
                      { timeout: 20000 },
                    )
                    .toBe(25);
                  expect(pending.length).toBeGreaterThanOrEqual(25);
                } finally {
                  hold = false;
                  for (const finish of pending.splice(0)) finish();
                }
                await expect
                  .poll(
                    () => threads.filter((id) => runtime.get(id).row?.state === "terminal").length,
                    { timeout: 20000 },
                  )
                  .toBe(25);
                expect(
                  threads.every((id) => runtime.get(id).row?.terminalOutcome === "completed"),
                ).toBe(true);
                failModel = true;
                await runtime.send({
                  ...input,
                  requestMessageId: MessageId.makeUnsafe("native-failure"),
                });
                await expect
                  .poll(() => runtime.get(threadId).row?.terminalOutcome, { timeout: 20000 })
                  .toBe("failed");
                failModel = false;
                hold = true;
                try {
                  const interrupted = await runtime.send({
                    ...input,
                    requestMessageId: MessageId.makeUnsafe("native-interrupted"),
                  });
                  await expect
                    .poll(() => pending.length, { timeout: 20000 })
                    .toBeGreaterThanOrEqual(1);
                  await runtime.interrupt(threadId, interrupted.turnId);
                  await expect
                    .poll(() => runtime.get(threadId).row?.terminalOutcome, { timeout: 20000 })
                    .toBe("interrupted");
                } finally {
                  hold = false;
                  for (const finish of pending.splice(0)) finish();
                }
                await runtime.stop(threadId);
                modelText = JSON.stringify({
                  userMemory: null,
                  globalMemory: null,
                  projectMemory: null,
                  skillPatch: null,
                });
                const review = makeV2LearningReview(runtime);
                const job = {
                  ownerThreadId: threadId,
                  jobId: "native-durable-learning",
                  cwd: directory,
                  modelSelection,
                  input: "Synthetic isolated learning review",
                };
                const result = await Effect.runPromise(review(job));
                expect(
                  await Effect.runPromise(validateSyntheticV2Learning(result, threadId, directory)),
                ).toEqual({ changed: [], skillPatch: null });
                const reviewCalls = calls;
                expect(await Effect.runPromise(review(job))).toBe(result);
                expect(calls).toBe(reviewCalls);
              });
            } finally {
              yield* Effect.promise(() => runtime.close());
            }
          }).pipe(Effect.provide(v2SharedNativePersistence)),
        ),
      );
    } finally {
      hold = false;
      for (const finish of pending.splice(0)) finish();
      await manager.close();
      harness.close();
      await fixture.close();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    }
  },
  60000,
);
