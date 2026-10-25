import { MessageId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { vi } from "vitest";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { guardV2Publication } from "./Runtime.publication.ts";
import { deferred } from "./Test.fixtures.ts";

/** Actual owner callback/source and SQLite runtime, with polling isolated from the SSE boundary. */
export async function withV2DeliveryFixture(
  sink: (event: ProviderRuntimeEvent) => void,
  run: (fixture: {
    runtime: OpencodeV2Runtime;
    owner: ReturnType<OpencodeV2Runtime["get"]>;
    http: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["http"];
    callback: Promise<unknown>;
    dirtyReasons: string[];
    deliver: () => void;
  }) => Promise<void>,
  options?: { readonly pollIntervalMs?: number },
) {
  await withV2RuntimeFixture(async ({ runtime: original, http, directory }) => {
    const finished = deferred<unknown>();
    const dirtyReasons: string[] = [];
    const register = OpencodeV2EventHub.prototype.register;
    const instrument = vi
      .spyOn(OpencodeV2EventHub.prototype, "register")
      .mockImplementation(function (this: OpencodeV2EventHub, owner) {
        return register.call(this, {
          ...owner,
          onEvent: async (event, signal) => {
            try {
              await owner.onEvent(event, signal);
              finished.resolve(undefined);
            } catch (error) {
              finished.resolve(error);
              throw error;
            }
          },
          onDirty: (reason) => {
            dirtyReasons.push(reason);
            owner.onDirty(reason);
          },
        });
      });
    const runtime = new OpencodeV2Runtime({
      ...original.options,
      pollIntervalMs: options?.pollIntervalMs ?? 60000,
      emit: async (event, validate) => {
        validate?.();
        guardV2Publication(event, validate);
        sink(event);
      },
    });
    try {
      http.autoComplete = false;
      const threadId = ThreadId.makeUnsafe("canonical-owned");
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      });
      await runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("healthy-sse-completion"),
        input: "fixture only",
      });
      const owner = runtime.get(threadId);
      http.complete(owner.native.id, "healthy final assistant output");
      const assistant = http.messages
        .get(owner.native.id)!
        .find((message) => message.type === "assistant")!;
      if (assistant.type !== "assistant") throw new Error("Missing fixture assistant.");
      assistant.content.unshift({
        type: "tool",
        id: "fixture-tool",
        name: "synthetic",
        time: { created: 3, completed: 4 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "healthy final tool output" }],
        },
      });
      await run({
        runtime,
        owner,
        http,
        callback: finished.promise,
        dirtyReasons,
        deliver: () =>
          http.source.push({
            id: "evt_healthy_completion",
            created: 5,
            type: "session.execution.succeeded",
            data: { sessionID: owner.native.id },
            location: { directory: owner.native.location.directory },
            durable: { version: 1, seq: 1, aggregateID: owner.native.id },
          }),
      });
    } finally {
      instrument.mockRestore();
      await runtime.close();
    }
  });
}
